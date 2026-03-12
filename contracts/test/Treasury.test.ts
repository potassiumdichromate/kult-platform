import { expect } from "chai";
import { ethers } from "hardhat";
import { AgentRegistry, Treasury } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, parseEther } from "ethers";

describe("Treasury", function () {
  let registry: AgentRegistry;
  let treasury: Treasury;

  let owner: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let alice: HardhatEthersSigner; // agent owner
  let aliceHot: HardhatEthersSigner; // agent hot wallet
  let bob: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const AGENT_ID = ethers.keccak256(ethers.toUtf8Bytes("agent-treasury-alice"));
  const ONE_ETH = parseEther("1");
  const HALF_ETH = parseEther("0.5");

  beforeEach(async function () {
    [owner, operator, alice, aliceHot, bob, stranger] = await ethers.getSigners();

    // Deploy registry
    const RegFactory = await ethers.getContractFactory("AgentRegistry");
    registry = (await RegFactory.deploy(owner.address, operator.address)) as AgentRegistry;
    await registry.waitForDeployment();

    // Deploy treasury
    const TreasuryFactory = await ethers.getContractFactory("Treasury");
    treasury = (await TreasuryFactory.deploy(
      owner.address,
      await registry.getAddress(),
      operator.address
    )) as Treasury;
    await treasury.waitForDeployment();

    // Register agent with hot wallet
    await registry.connect(operator).registerAgent(AGENT_ID, alice.address);
    await registry.connect(alice).updateWallet(AGENT_ID, aliceHot.address);
  });

  // ─────────────────────────────────────────────
  //  Deployment
  // ─────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets owner correctly", async function () {
      expect(await treasury.owner()).to.equal(owner.address);
    });

    it("sets operator correctly", async function () {
      expect(await treasury.operator()).to.equal(operator.address);
    });

    it("sets registry correctly", async function () {
      expect(await treasury.registry()).to.equal(await registry.getAddress());
    });

    it("reverts if registry is zero address", async function () {
      const Factory = await ethers.getContractFactory("Treasury");
      await expect(
        Factory.deploy(owner.address, ZeroAddress, operator.address)
      ).to.be.revertedWith("Treasury: registry is zero address");
    });

    it("reverts if operator is zero address", async function () {
      const Factory = await ethers.getContractFactory("Treasury");
      await expect(
        Factory.deploy(owner.address, await registry.getAddress(), ZeroAddress)
      ).to.be.revertedWith("Treasury: operator is zero address");
    });
  });

  // ─────────────────────────────────────────────
  //  setOperator
  // ─────────────────────────────────────────────

  describe("setOperator", function () {
    it("owner can set new operator", async function () {
      await expect(treasury.connect(owner).setOperator(bob.address))
        .to.emit(treasury, "OperatorSet")
        .withArgs(operator.address, bob.address);
      expect(await treasury.operator()).to.equal(bob.address);
    });

    it("reverts if caller is not owner", async function () {
      await expect(
        treasury.connect(stranger).setOperator(bob.address)
      ).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });

    it("reverts if new operator is zero address", async function () {
      await expect(
        treasury.connect(owner).setOperator(ZeroAddress)
      ).to.be.revertedWith("Treasury: operator is zero address");
    });
  });

  // ─────────────────────────────────────────────
  //  deposit
  // ─────────────────────────────────────────────

  describe("deposit", function () {
    it("anyone can deposit via deposit()", async function () {
      await expect(treasury.connect(stranger).deposit({ value: ONE_ETH }))
        .to.emit(treasury, "Deposited")
        .withArgs(stranger.address, ONE_ETH);

      expect(await treasury.getBalance()).to.equal(ONE_ETH);
    });

    it("accepts direct ETH via receive()", async function () {
      await stranger.sendTransaction({ to: await treasury.getAddress(), value: ONE_ETH });
      expect(await treasury.getBalance()).to.equal(ONE_ETH);
    });

    it("accepts direct ETH via fallback()", async function () {
      await stranger.sendTransaction({
        to: await treasury.getAddress(),
        value: ONE_ETH,
        data: "0xdeadbeef",
      });
      expect(await treasury.getBalance()).to.equal(ONE_ETH);
    });

    it("reverts if deposit amount is zero", async function () {
      await expect(treasury.connect(stranger).deposit({ value: 0 })).to.be.revertedWith(
        "Treasury: deposit must be > 0"
      );
    });

    it("accumulates multiple deposits", async function () {
      await treasury.connect(stranger).deposit({ value: ONE_ETH });
      await treasury.connect(alice).deposit({ value: HALF_ETH });
      expect(await treasury.getBalance()).to.equal(ONE_ETH + HALF_ETH);
    });
  });

  // ─────────────────────────────────────────────
  //  withdraw
  // ─────────────────────────────────────────────

  describe("withdraw", function () {
    beforeEach(async function () {
      await treasury.connect(stranger).deposit({ value: ONE_ETH });
    });

    it("owner can withdraw partial amount", async function () {
      const before = await ethers.provider.getBalance(owner.address);
      const tx = await treasury.connect(owner).withdraw(HALF_ETH);
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice;
      const after = await ethers.provider.getBalance(owner.address);

      expect(after).to.be.closeTo(before + HALF_ETH - gas, parseEther("0.0001"));
      await expect(tx).to.emit(treasury, "Withdrawn").withArgs(owner.address, HALF_ETH);
    });

    it("owner can withdraw full amount", async function () {
      await expect(treasury.connect(owner).withdraw(ONE_ETH))
        .to.emit(treasury, "Withdrawn")
        .withArgs(owner.address, ONE_ETH);

      expect(await treasury.getBalance()).to.equal(0n);
    });

    it("reverts if caller is not owner", async function () {
      await expect(
        treasury.connect(stranger).withdraw(HALF_ETH)
      ).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });

    it("reverts if amount is zero", async function () {
      await expect(treasury.connect(owner).withdraw(0n)).to.be.revertedWith(
        "Treasury: amount must be > 0"
      );
    });

    it("reverts if amount exceeds balance", async function () {
      await expect(
        treasury.connect(owner).withdraw(ONE_ETH + 1n)
      ).to.be.revertedWith("Treasury: insufficient balance");
    });
  });

  // ─────────────────────────────────────────────
  //  transferToAgent
  // ─────────────────────────────────────────────

  describe("transferToAgent", function () {
    beforeEach(async function () {
      await treasury.connect(stranger).deposit({ value: ONE_ETH });
    });

    it("operator can transfer to agent hot wallet", async function () {
      const before = await ethers.provider.getBalance(aliceHot.address);
      await expect(treasury.connect(operator).transferToAgent(AGENT_ID, HALF_ETH))
        .to.emit(treasury, "TransferredToAgent")
        .withArgs(AGENT_ID, aliceHot.address, HALF_ETH);

      const after = await ethers.provider.getBalance(aliceHot.address);
      expect(after - before).to.equal(HALF_ETH);
    });

    it("reduces treasury balance", async function () {
      await treasury.connect(operator).transferToAgent(AGENT_ID, HALF_ETH);
      expect(await treasury.getBalance()).to.equal(ONE_ETH - HALF_ETH);
    });

    it("reverts if caller is not operator", async function () {
      await expect(
        treasury.connect(stranger).transferToAgent(AGENT_ID, HALF_ETH)
      ).to.be.revertedWith("Treasury: caller is not the operator");
    });

    it("reverts if amount is zero", async function () {
      await expect(
        treasury.connect(operator).transferToAgent(AGENT_ID, 0n)
      ).to.be.revertedWith("Treasury: amount must be > 0");
    });

    it("reverts if amount exceeds balance", async function () {
      await expect(
        treasury.connect(operator).transferToAgent(AGENT_ID, ONE_ETH + 1n)
      ).to.be.revertedWith("Treasury: insufficient balance");
    });

    it("reverts if agent is inactive", async function () {
      await registry.connect(operator).deactivateAgent(AGENT_ID);
      await expect(
        treasury.connect(operator).transferToAgent(AGENT_ID, HALF_ETH)
      ).to.be.revertedWith("Treasury: agent is not active");
    });

    it("reverts if agent has no hot wallet", async function () {
      const AGENT_ID_2 = ethers.keccak256(ethers.toUtf8Bytes("agent-treasury-bob"));
      await registry.connect(operator).registerAgent(AGENT_ID_2, bob.address);
      // No hot wallet — transferToAgent requires hot wallet

      await expect(
        treasury.connect(operator).transferToAgent(AGENT_ID_2, HALF_ETH)
      ).to.be.revertedWith("Treasury: agent has no hot wallet");
    });
  });

  // ─────────────────────────────────────────────
  //  transferToAgentAddress (useOwner flag)
  // ─────────────────────────────────────────────

  describe("transferToAgentAddress", function () {
    beforeEach(async function () {
      await treasury.connect(stranger).deposit({ value: ONE_ETH });
    });

    it("operator can transfer to agent owner (useOwner=true)", async function () {
      const before = await ethers.provider.getBalance(alice.address);
      await treasury.connect(operator).transferToAgentAddress(AGENT_ID, HALF_ETH, true);
      const after = await ethers.provider.getBalance(alice.address);
      expect(after - before).to.equal(HALF_ETH);
    });

    it("operator can transfer to hot wallet (useOwner=false)", async function () {
      const before = await ethers.provider.getBalance(aliceHot.address);
      await treasury.connect(operator).transferToAgentAddress(AGENT_ID, HALF_ETH, false);
      const after = await ethers.provider.getBalance(aliceHot.address);
      expect(after - before).to.equal(HALF_ETH);
    });

    it("reverts if caller is not operator", async function () {
      await expect(
        treasury.connect(stranger).transferToAgentAddress(AGENT_ID, HALF_ETH, true)
      ).to.be.revertedWith("Treasury: caller is not the operator");
    });
  });

  // ─────────────────────────────────────────────
  //  getBalance
  // ─────────────────────────────────────────────

  describe("getBalance", function () {
    it("returns zero on empty treasury", async function () {
      expect(await treasury.getBalance()).to.equal(0n);
    });

    it("returns correct balance after deposits and withdrawals", async function () {
      await treasury.connect(stranger).deposit({ value: ONE_ETH });
      await treasury.connect(owner).withdraw(HALF_ETH);
      expect(await treasury.getBalance()).to.equal(HALF_ETH);
    });
  });
});
