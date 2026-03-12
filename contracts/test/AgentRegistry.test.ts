import { expect } from "chai";
import { ethers } from "hardhat";
import { AgentRegistry } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress } from "ethers";

describe("AgentRegistry", function () {
  let registry: AgentRegistry;
  let owner: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  // Deterministic agent IDs (keccak256 of strings)
  const AGENT_ID_1 = ethers.keccak256(ethers.toUtf8Bytes("agent-1"));
  const AGENT_ID_2 = ethers.keccak256(ethers.toUtf8Bytes("agent-2"));

  beforeEach(async function () {
    [owner, operator, alice, bob, carol, stranger] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("AgentRegistry");
    registry = (await Factory.deploy(owner.address, operator.address)) as AgentRegistry;
    await registry.waitForDeployment();
  });

  // ─────────────────────────────────────────────
  //  Deployment
  // ─────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets the correct owner", async function () {
      expect(await registry.owner()).to.equal(owner.address);
    });

    it("sets the correct operator", async function () {
      expect(await registry.operator()).to.equal(operator.address);
    });

    it("reverts if operator is zero address", async function () {
      const Factory = await ethers.getContractFactory("AgentRegistry");
      await expect(
        Factory.deploy(owner.address, ZeroAddress)
      ).to.be.revertedWith("AgentRegistry: operator is zero address");
    });
  });

  // ─────────────────────────────────────────────
  //  setOperator
  // ─────────────────────────────────────────────

  describe("setOperator", function () {
    it("owner can set a new operator", async function () {
      await expect(registry.connect(owner).setOperator(bob.address))
        .to.emit(registry, "OperatorSet")
        .withArgs(operator.address, bob.address);

      expect(await registry.operator()).to.equal(bob.address);
    });

    it("reverts if caller is not owner", async function () {
      await expect(
        registry.connect(stranger).setOperator(bob.address)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("reverts if new operator is zero address", async function () {
      await expect(
        registry.connect(owner).setOperator(ZeroAddress)
      ).to.be.revertedWith("AgentRegistry: operator is zero address");
    });
  });

  // ─────────────────────────────────────────────
  //  registerAgent
  // ─────────────────────────────────────────────

  describe("registerAgent", function () {
    it("operator can register an agent", async function () {
      await expect(registry.connect(operator).registerAgent(AGENT_ID_1, alice.address))
        .to.emit(registry, "AgentRegistered")
        .withArgs(AGENT_ID_1, alice.address, await getBlockTimestamp());

      expect(await registry.isRegistered(AGENT_ID_1)).to.be.true;
    });

    it("registers agent with correct data", async function () {
      await registry.connect(operator).registerAgent(AGENT_ID_1, alice.address);
      const agent = await registry.getAgent(AGENT_ID_1);

      expect(agent.owner).to.equal(alice.address);
      expect(agent.hotWallet).to.equal(ZeroAddress);
      expect(agent.isActive).to.be.true;
      expect(agent.registeredAt).to.be.gt(0n);
    });

    it("reverts if called by non-operator", async function () {
      await expect(
        registry.connect(stranger).registerAgent(AGENT_ID_1, alice.address)
      ).to.be.revertedWith("AgentRegistry: caller is not the operator");
    });

    it("reverts if agentId is zero", async function () {
      await expect(
        registry.connect(operator).registerAgent(ethers.ZeroHash, alice.address)
      ).to.be.revertedWith("AgentRegistry: agentId is zero");
    });

    it("reverts if owner is zero address", async function () {
      await expect(
        registry.connect(operator).registerAgent(AGENT_ID_1, ZeroAddress)
      ).to.be.revertedWith("AgentRegistry: owner is zero address");
    });

    it("reverts if agent already registered", async function () {
      await registry.connect(operator).registerAgent(AGENT_ID_1, alice.address);
      await expect(
        registry.connect(operator).registerAgent(AGENT_ID_1, bob.address)
      ).to.be.revertedWith("AgentRegistry: agent already registered");
    });

    it("allows multiple distinct agents", async function () {
      await registry.connect(operator).registerAgent(AGENT_ID_1, alice.address);
      await registry.connect(operator).registerAgent(AGENT_ID_2, bob.address);

      expect((await registry.getAgent(AGENT_ID_1)).owner).to.equal(alice.address);
      expect((await registry.getAgent(AGENT_ID_2)).owner).to.equal(bob.address);
    });
  });

  // ─────────────────────────────────────────────
  //  updateWallet
  // ─────────────────────────────────────────────

  describe("updateWallet", function () {
    beforeEach(async function () {
      await registry.connect(operator).registerAgent(AGENT_ID_1, alice.address);
    });

    it("agent owner can set a hot wallet", async function () {
      await expect(registry.connect(alice).updateWallet(AGENT_ID_1, carol.address))
        .to.emit(registry, "WalletUpdated")
        .withArgs(AGENT_ID_1, ZeroAddress, carol.address);

      const agent = await registry.getAgent(AGENT_ID_1);
      expect(agent.hotWallet).to.equal(carol.address);
    });

    it("agent owner can change hot wallet", async function () {
      await registry.connect(alice).updateWallet(AGENT_ID_1, carol.address);
      await registry.connect(alice).updateWallet(AGENT_ID_1, bob.address);

      expect((await registry.getAgent(AGENT_ID_1)).hotWallet).to.equal(bob.address);
    });

    it("agent owner can clear hot wallet (set to zero)", async function () {
      await registry.connect(alice).updateWallet(AGENT_ID_1, carol.address);
      await registry.connect(alice).updateWallet(AGENT_ID_1, ZeroAddress);

      expect((await registry.getAgent(AGENT_ID_1)).hotWallet).to.equal(ZeroAddress);
    });

    it("reverts if caller is not agent owner", async function () {
      await expect(
        registry.connect(stranger).updateWallet(AGENT_ID_1, carol.address)
      ).to.be.revertedWith("AgentRegistry: caller is not the agent owner");
    });

    it("reverts for unregistered agentId", async function () {
      await expect(
        registry.connect(alice).updateWallet(AGENT_ID_2, carol.address)
      ).to.be.revertedWith("AgentRegistry: agent does not exist");
    });
  });

  // ─────────────────────────────────────────────
  //  transferAgent
  // ─────────────────────────────────────────────

  describe("transferAgent", function () {
    beforeEach(async function () {
      await registry.connect(operator).registerAgent(AGENT_ID_1, alice.address);
    });

    it("agent owner can transfer ownership", async function () {
      await expect(registry.connect(alice).transferAgent(AGENT_ID_1, bob.address))
        .to.emit(registry, "AgentTransferred")
        .withArgs(AGENT_ID_1, alice.address, bob.address);

      expect((await registry.getAgent(AGENT_ID_1)).owner).to.equal(bob.address);
    });

    it("new owner can subsequently update wallet", async function () {
      await registry.connect(alice).transferAgent(AGENT_ID_1, bob.address);
      await registry.connect(bob).updateWallet(AGENT_ID_1, carol.address);

      expect((await registry.getAgent(AGENT_ID_1)).hotWallet).to.equal(carol.address);
    });

    it("previous owner cannot interact after transfer", async function () {
      await registry.connect(alice).transferAgent(AGENT_ID_1, bob.address);
      await expect(
        registry.connect(alice).updateWallet(AGENT_ID_1, carol.address)
      ).to.be.revertedWith("AgentRegistry: caller is not the agent owner");
    });

    it("reverts if new owner is zero address", async function () {
      await expect(
        registry.connect(alice).transferAgent(AGENT_ID_1, ZeroAddress)
      ).to.be.revertedWith("AgentRegistry: new owner is zero address");
    });

    it("reverts if caller is not agent owner", async function () {
      await expect(
        registry.connect(stranger).transferAgent(AGENT_ID_1, bob.address)
      ).to.be.revertedWith("AgentRegistry: caller is not the agent owner");
    });
  });

  // ─────────────────────────────────────────────
  //  deactivateAgent / activateAgent
  // ─────────────────────────────────────────────

  describe("deactivate / activate", function () {
    beforeEach(async function () {
      await registry.connect(operator).registerAgent(AGENT_ID_1, alice.address);
    });

    it("operator can deactivate an agent", async function () {
      await expect(registry.connect(operator).deactivateAgent(AGENT_ID_1))
        .to.emit(registry, "AgentDeactivated")
        .withArgs(AGENT_ID_1);

      expect(await registry.isActive(AGENT_ID_1)).to.be.false;
    });

    it("operator can reactivate an agent", async function () {
      await registry.connect(operator).deactivateAgent(AGENT_ID_1);
      await expect(registry.connect(operator).activateAgent(AGENT_ID_1))
        .to.emit(registry, "AgentActivated")
        .withArgs(AGENT_ID_1);

      expect(await registry.isActive(AGENT_ID_1)).to.be.true;
    });

    it("reverts deactivate for non-operator", async function () {
      await expect(
        registry.connect(stranger).deactivateAgent(AGENT_ID_1)
      ).to.be.revertedWith("AgentRegistry: caller is not the operator");
    });
  });

  // ─────────────────────────────────────────────
  //  getAgent / getHotWallet / getOwner
  // ─────────────────────────────────────────────

  describe("getAgent", function () {
    it("returns correct data after registration and wallet update", async function () {
      await registry.connect(operator).registerAgent(AGENT_ID_1, alice.address);
      await registry.connect(alice).updateWallet(AGENT_ID_1, carol.address);

      const agent = await registry.getAgent(AGENT_ID_1);
      expect(agent.owner).to.equal(alice.address);
      expect(agent.hotWallet).to.equal(carol.address);
      expect(agent.isActive).to.be.true;
    });

    it("reverts for unregistered agent", async function () {
      await expect(registry.getAgent(AGENT_ID_2)).to.be.revertedWith(
        "AgentRegistry: agent does not exist"
      );
    });

    it("getHotWallet returns hot wallet", async function () {
      await registry.connect(operator).registerAgent(AGENT_ID_1, alice.address);
      await registry.connect(alice).updateWallet(AGENT_ID_1, carol.address);
      expect(await registry.getHotWallet(AGENT_ID_1)).to.equal(carol.address);
    });

    it("getOwner returns owner", async function () {
      await registry.connect(operator).registerAgent(AGENT_ID_1, alice.address);
      expect(await registry.getOwner(AGENT_ID_1)).to.equal(alice.address);
    });

    it("isRegistered returns false for unknown id", async function () {
      expect(await registry.isRegistered(AGENT_ID_2)).to.be.false;
    });
  });

  // ─────────────────────────────────────────────
  //  Helpers
  // ─────────────────────────────────────────────

  async function getBlockTimestamp(): Promise<bigint> {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block!.timestamp + 1); // next block
  }
});
