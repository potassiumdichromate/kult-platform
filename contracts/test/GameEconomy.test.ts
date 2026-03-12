import { expect } from "chai";
import { ethers } from "hardhat";
import { AgentRegistry, GameEconomy } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, parseEther } from "ethers";

describe("GameEconomy", function () {
  let registry: AgentRegistry;
  let economy: GameEconomy;

  let owner: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let alice: HardhatEthersSigner; // agent owner
  let aliceHot: HardhatEthersSigner; // agent hot wallet
  let bob: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const AGENT_ID = ethers.keccak256(ethers.toUtf8Bytes("agent-alice"));

  // Weapon catalogue
  const WEAPON_ID = 1n;
  const WEAPON_NAME = "Plasma Rifle";
  const WEAPON_COST = parseEther("0.01"); // 0.01 ETH

  async function deployAll() {
    [owner, operator, alice, aliceHot, bob, stranger] = await ethers.getSigners();

    // Deploy registry
    const RegFactory = await ethers.getContractFactory("AgentRegistry");
    registry = (await RegFactory.deploy(owner.address, operator.address)) as AgentRegistry;
    await registry.waitForDeployment();

    // Deploy economy
    const EcoFactory = await ethers.getContractFactory("GameEconomy");
    economy = (await EcoFactory.deploy(owner.address, await registry.getAddress())) as GameEconomy;
    await economy.waitForDeployment();

    // Register agent with hot wallet
    await registry.connect(operator).registerAgent(AGENT_ID, alice.address);
    await registry.connect(alice).updateWallet(AGENT_ID, aliceHot.address);

    // Add default weapon
    await economy.connect(owner).addWeapon(WEAPON_ID, WEAPON_NAME, WEAPON_COST);
  }

  beforeEach(deployAll);

  // ─────────────────────────────────────────────
  //  Deployment
  // ─────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets registry correctly", async function () {
      expect(await economy.registry()).to.equal(await registry.getAddress());
    });

    it("sets owner correctly", async function () {
      expect(await economy.owner()).to.equal(owner.address);
    });

    it("reverts if registry is zero address", async function () {
      const Factory = await ethers.getContractFactory("GameEconomy");
      await expect(Factory.deploy(owner.address, ZeroAddress)).to.be.revertedWith(
        "GameEconomy: registry is zero address"
      );
    });
  });

  // ─────────────────────────────────────────────
  //  addWeapon
  // ─────────────────────────────────────────────

  describe("addWeapon", function () {
    it("owner can add a weapon", async function () {
      await expect(economy.connect(owner).addWeapon(2n, "Laser Sword", parseEther("0.02")))
        .to.emit(economy, "WeaponAdded")
        .withArgs(2n, "Laser Sword", parseEther("0.02"));

      const w = await economy.getWeapon(2n);
      expect(w.weaponId).to.equal(2n);
      expect(w.name).to.equal("Laser Sword");
      expect(w.baseCost).to.equal(parseEther("0.02"));
      expect(w.isActive).to.be.true;
    });

    it("reverts if not owner", async function () {
      await expect(
        economy.connect(stranger).addWeapon(99n, "Hack Knife", parseEther("0.001"))
      ).to.be.revertedWithCustomError(economy, "OwnableUnauthorizedAccount");
    });

    it("reverts on duplicate weaponId", async function () {
      await expect(
        economy.connect(owner).addWeapon(WEAPON_ID, "Duplicate", parseEther("0.001"))
      ).to.be.revertedWith("GameEconomy: weapon already exists");
    });

    it("reverts if baseCost is zero", async function () {
      await expect(
        economy.connect(owner).addWeapon(99n, "Free Gun", 0n)
      ).to.be.revertedWith("GameEconomy: baseCost must be > 0");
    });

    it("reverts if name is empty", async function () {
      await expect(
        economy.connect(owner).addWeapon(99n, "", parseEther("0.001"))
      ).to.be.revertedWith("GameEconomy: name cannot be empty");
    });
  });

  // ─────────────────────────────────────────────
  //  updateWeapon
  // ─────────────────────────────────────────────

  describe("updateWeapon", function () {
    it("owner can deactivate a weapon", async function () {
      await economy.connect(owner).updateWeapon(WEAPON_ID, "", 0n, false);
      const w = await economy.getWeapon(WEAPON_ID);
      expect(w.isActive).to.be.false;
    });

    it("owner can update name and cost", async function () {
      await economy.connect(owner).updateWeapon(WEAPON_ID, "Super Rifle", parseEther("0.05"), true);
      const w = await economy.getWeapon(WEAPON_ID);
      expect(w.name).to.equal("Super Rifle");
      expect(w.baseCost).to.equal(parseEther("0.05"));
    });

    it("reverts for non-existent weapon", async function () {
      await expect(
        economy.connect(owner).updateWeapon(999n, "", 0n, false)
      ).to.be.revertedWith("GameEconomy: weapon does not exist");
    });
  });

  // ─────────────────────────────────────────────
  //  buyWeapon
  // ─────────────────────────────────────────────

  describe("buyWeapon", function () {
    it("hot wallet can purchase a weapon at exact cost", async function () {
      await expect(
        economy.connect(aliceHot).buyWeapon(AGENT_ID, WEAPON_ID, { value: WEAPON_COST })
      )
        .to.emit(economy, "WeaponPurchased")
        .withArgs(AGENT_ID, WEAPON_ID, aliceHot.address, WEAPON_COST);

      const [owned, level] = await economy.getAgentWeapon(AGENT_ID, WEAPON_ID);
      expect(owned).to.be.true;
      expect(level).to.equal(0n);
    });

    it("refunds overpayment", async function () {
      const overpay = parseEther("0.1");
      const before = await ethers.provider.getBalance(aliceHot.address);
      const tx = await economy
        .connect(aliceHot)
        .buyWeapon(AGENT_ID, WEAPON_ID, { value: overpay });
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const after = await ethers.provider.getBalance(aliceHot.address);

      // Net cost = WEAPON_COST + gas (overpay refunded)
      const netSpent = before - after;
      expect(netSpent).to.be.closeTo(WEAPON_COST + gasUsed, parseEther("0.0001"));
    });

    it("reverts if value < baseCost", async function () {
      await expect(
        economy.connect(aliceHot).buyWeapon(AGENT_ID, WEAPON_ID, { value: WEAPON_COST - 1n })
      ).to.be.revertedWith("GameEconomy: insufficient payment");
    });

    it("reverts if caller is not hot wallet", async function () {
      await expect(
        economy.connect(stranger).buyWeapon(AGENT_ID, WEAPON_ID, { value: WEAPON_COST })
      ).to.be.revertedWith("GameEconomy: caller is not agent hot-wallet");
    });

    it("falls back to owner if no hot wallet set", async function () {
      const AGENT_ID_2 = ethers.keccak256(ethers.toUtf8Bytes("agent-bob"));
      await registry.connect(operator).registerAgent(AGENT_ID_2, bob.address);
      // No hot wallet set — bob is both owner and authorized caller

      await expect(
        economy.connect(bob).buyWeapon(AGENT_ID_2, WEAPON_ID, { value: WEAPON_COST })
      ).to.emit(economy, "WeaponPurchased");
    });

    it("reverts if weapon does not exist", async function () {
      await expect(
        economy.connect(aliceHot).buyWeapon(AGENT_ID, 999n, { value: WEAPON_COST })
      ).to.be.revertedWith("GameEconomy: weapon does not exist");
    });

    it("reverts if weapon is inactive", async function () {
      await economy.connect(owner).updateWeapon(WEAPON_ID, "", 0n, false);
      await expect(
        economy.connect(aliceHot).buyWeapon(AGENT_ID, WEAPON_ID, { value: WEAPON_COST })
      ).to.be.revertedWith("GameEconomy: weapon is not active");
    });

    it("reverts on double purchase", async function () {
      await economy.connect(aliceHot).buyWeapon(AGENT_ID, WEAPON_ID, { value: WEAPON_COST });
      await expect(
        economy.connect(aliceHot).buyWeapon(AGENT_ID, WEAPON_ID, { value: WEAPON_COST })
      ).to.be.revertedWith("GameEconomy: agent already owns weapon");
    });

    it("reverts if agent is inactive", async function () {
      await registry.connect(operator).deactivateAgent(AGENT_ID);
      await expect(
        economy.connect(aliceHot).buyWeapon(AGENT_ID, WEAPON_ID, { value: WEAPON_COST })
      ).to.be.revertedWith("GameEconomy: agent is not active");
    });
  });

  // ─────────────────────────────────────────────
  //  upgradeWeapon
  // ─────────────────────────────────────────────

  describe("upgradeWeapon", function () {
    beforeEach(async function () {
      // Alice buys the weapon first
      await economy.connect(aliceHot).buyWeapon(AGENT_ID, WEAPON_ID, { value: WEAPON_COST });
    });

    it("hot wallet can upgrade an owned weapon (level 0 -> 1)", async function () {
      // cost = baseCost * 1.5^1 = 0.01 * 1.5 = 0.015 ETH
      const upgradeCost = (WEAPON_COST * 150n) / 100n;

      await expect(
        economy.connect(aliceHot).upgradeWeapon(AGENT_ID, WEAPON_ID, { value: upgradeCost })
      )
        .to.emit(economy, "WeaponUpgraded")
        .withArgs(AGENT_ID, WEAPON_ID, 1n, upgradeCost);

      const [, level] = await economy.getAgentWeapon(AGENT_ID, WEAPON_ID);
      expect(level).to.equal(1n);
    });

    it("calculates cost correctly for level 1 -> 2", async function () {
      // level 0->1 cost
      const cost1 = (WEAPON_COST * 150n) / 100n;
      await economy.connect(aliceHot).upgradeWeapon(AGENT_ID, WEAPON_ID, { value: cost1 });

      // level 1->2 cost = baseCost * 1.5^2 = 0.01 * 2.25 = 0.0225
      const cost2 = (WEAPON_COST * 150n * 150n) / (100n * 100n);
      const nextCost = await economy.getNextUpgradeCost(AGENT_ID, WEAPON_ID);
      expect(nextCost).to.equal(cost2);

      await expect(
        economy.connect(aliceHot).upgradeWeapon(AGENT_ID, WEAPON_ID, { value: cost2 })
      ).to.emit(economy, "WeaponUpgraded").withArgs(AGENT_ID, WEAPON_ID, 2n, cost2);
    });

    it("reverts if payment is insufficient", async function () {
      const upgradeCost = (WEAPON_COST * 150n) / 100n;
      await expect(
        economy.connect(aliceHot).upgradeWeapon(AGENT_ID, WEAPON_ID, { value: upgradeCost - 1n })
      ).to.be.revertedWith("GameEconomy: insufficient upgrade payment");
    });

    it("reverts if agent does not own weapon", async function () {
      const AGENT_ID_2 = ethers.keccak256(ethers.toUtf8Bytes("agent-bob"));
      await registry.connect(operator).registerAgent(AGENT_ID_2, bob.address);
      const upgradeCost = (WEAPON_COST * 150n) / 100n;

      await expect(
        economy.connect(bob).upgradeWeapon(AGENT_ID_2, WEAPON_ID, { value: upgradeCost })
      ).to.be.revertedWith("GameEconomy: agent does not own weapon");
    });

    it("reverts if caller is not hot wallet", async function () {
      const upgradeCost = (WEAPON_COST * 150n) / 100n;
      await expect(
        economy.connect(stranger).upgradeWeapon(AGENT_ID, WEAPON_ID, { value: upgradeCost })
      ).to.be.revertedWith("GameEconomy: caller is not agent hot-wallet");
    });

    it("getNextUpgradeCost returns correct value at level 0", async function () {
      const expected = (WEAPON_COST * 150n) / 100n;
      expect(await economy.getNextUpgradeCost(AGENT_ID, WEAPON_ID)).to.equal(expected);
    });
  });

  // ─────────────────────────────────────────────
  //  withdraw
  // ─────────────────────────────────────────────

  describe("withdraw", function () {
    beforeEach(async function () {
      await economy.connect(aliceHot).buyWeapon(AGENT_ID, WEAPON_ID, { value: WEAPON_COST });
    });

    it("owner can withdraw accumulated ETH", async function () {
      const before = await ethers.provider.getBalance(owner.address);
      const tx = await economy.connect(owner).withdraw();
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice;
      const after = await ethers.provider.getBalance(owner.address);

      expect(after).to.be.closeTo(before + WEAPON_COST - gas, parseEther("0.0001"));
      await expect(tx).to.emit(economy, "Withdrawn").withArgs(owner.address, WEAPON_COST);
    });

    it("reverts if not owner", async function () {
      await expect(economy.connect(stranger).withdraw()).to.be.revertedWithCustomError(
        economy,
        "OwnableUnauthorizedAccount"
      );
    });

    it("reverts if balance is zero", async function () {
      await economy.connect(owner).withdraw();
      await expect(economy.connect(owner).withdraw()).to.be.revertedWith(
        "GameEconomy: nothing to withdraw"
      );
    });
  });

  // ─────────────────────────────────────────────
  //  View helpers
  // ─────────────────────────────────────────────

  describe("view helpers", function () {
    it("getAllWeaponIds returns registered weapons", async function () {
      await economy.connect(owner).addWeapon(2n, "Sword", parseEther("0.005"));
      const ids = await economy.getAllWeaponIds();
      expect(ids).to.deep.equal([WEAPON_ID, 2n]);
    });

    it("getBalance reflects contract ETH", async function () {
      expect(await economy.getBalance()).to.equal(0n);
      await economy.connect(aliceHot).buyWeapon(AGENT_ID, WEAPON_ID, { value: WEAPON_COST });
      expect(await economy.getBalance()).to.equal(WEAPON_COST);
    });
  });
});
