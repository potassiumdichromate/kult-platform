import { expect } from "chai";
import { ethers } from "hardhat";
import { Settlement } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress } from "ethers";

describe("Settlement", function () {
  let settlement: Settlement;

  let owner: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let verifier: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const TOURNAMENT_ID = 42n;
  const RESULT_HASH = ethers.keccak256(ethers.toUtf8Bytes("tournament-42-results"));
  const RESULT_HASH_2 = ethers.keccak256(ethers.toUtf8Bytes("tournament-43-results"));

  beforeEach(async function () {
    [owner, operator, verifier, stranger] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("Settlement");
    settlement = (await Factory.deploy(owner.address, operator.address)) as Settlement;
    await settlement.waitForDeployment();
  });

  // ─────────────────────────────────────────────
  //  Deployment
  // ─────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets owner correctly", async function () {
      expect(await settlement.owner()).to.equal(owner.address);
    });

    it("sets operator correctly", async function () {
      expect(await settlement.operator()).to.equal(operator.address);
    });

    it("sets verifier to operator initially", async function () {
      expect(await settlement.verifier()).to.equal(operator.address);
    });

    it("reverts if operator is zero address", async function () {
      const Factory = await ethers.getContractFactory("Settlement");
      await expect(Factory.deploy(owner.address, ZeroAddress)).to.be.revertedWith(
        "Settlement: operator is zero address"
      );
    });
  });

  // ─────────────────────────────────────────────
  //  setOperator
  // ─────────────────────────────────────────────

  describe("setOperator", function () {
    it("owner can set a new operator", async function () {
      await expect(settlement.connect(owner).setOperator(verifier.address))
        .to.emit(settlement, "OperatorSet")
        .withArgs(operator.address, verifier.address);

      expect(await settlement.operator()).to.equal(verifier.address);
    });

    it("reverts if caller is not owner", async function () {
      await expect(
        settlement.connect(stranger).setOperator(verifier.address)
      ).to.be.revertedWithCustomError(settlement, "OwnableUnauthorizedAccount");
    });

    it("reverts if new operator is zero address", async function () {
      await expect(
        settlement.connect(owner).setOperator(ZeroAddress)
      ).to.be.revertedWith("Settlement: operator is zero address");
    });
  });

  // ─────────────────────────────────────────────
  //  setVerifier
  // ─────────────────────────────────────────────

  describe("setVerifier", function () {
    it("owner can set a new verifier", async function () {
      await expect(settlement.connect(owner).setVerifier(verifier.address))
        .to.emit(settlement, "VerifierSet")
        .withArgs(operator.address, verifier.address);

      expect(await settlement.verifier()).to.equal(verifier.address);
    });

    it("reverts if caller is not owner", async function () {
      await expect(
        settlement.connect(stranger).setVerifier(verifier.address)
      ).to.be.revertedWithCustomError(settlement, "OwnableUnauthorizedAccount");
    });

    it("reverts if new verifier is zero address", async function () {
      await expect(
        settlement.connect(owner).setVerifier(ZeroAddress)
      ).to.be.revertedWith("Settlement: verifier is zero address");
    });
  });

  // ─────────────────────────────────────────────
  //  submitSettlement
  // ─────────────────────────────────────────────

  describe("submitSettlement", function () {
    it("operator can submit a settlement", async function () {
      const tx = await settlement
        .connect(operator)
        .submitSettlement(TOURNAMENT_ID, RESULT_HASH);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      await expect(tx)
        .to.emit(settlement, "SettlementSubmitted")
        .withArgs(TOURNAMENT_ID, RESULT_HASH, operator.address, block!.timestamp);

      expect(await settlement.isSettled(TOURNAMENT_ID)).to.be.true;
    });

    it("stores correct data", async function () {
      await settlement.connect(operator).submitSettlement(TOURNAMENT_ID, RESULT_HASH);
      const record = await settlement.verifySettlement(TOURNAMENT_ID);

      expect(record.tournamentId).to.equal(TOURNAMENT_ID);
      expect(record.resultHash).to.equal(RESULT_HASH);
      expect(record.submitter).to.equal(operator.address);
      expect(record.timestamp).to.be.gt(0n);
      expect(record.verified).to.be.false;
    });

    it("allows multiple distinct tournaments", async function () {
      await settlement.connect(operator).submitSettlement(TOURNAMENT_ID, RESULT_HASH);
      await settlement.connect(operator).submitSettlement(100n, RESULT_HASH_2);

      expect(await settlement.isSettled(TOURNAMENT_ID)).to.be.true;
      expect(await settlement.isSettled(100n)).to.be.true;
    });

    it("reverts if caller is not operator", async function () {
      await expect(
        settlement.connect(stranger).submitSettlement(TOURNAMENT_ID, RESULT_HASH)
      ).to.be.revertedWith("Settlement: caller is not the operator");
    });

    it("reverts if resultHash is zero", async function () {
      await expect(
        settlement.connect(operator).submitSettlement(TOURNAMENT_ID, ethers.ZeroHash)
      ).to.be.revertedWith("Settlement: resultHash is zero");
    });

    it("reverts on double submission for same tournamentId", async function () {
      await settlement.connect(operator).submitSettlement(TOURNAMENT_ID, RESULT_HASH);
      await expect(
        settlement.connect(operator).submitSettlement(TOURNAMENT_ID, RESULT_HASH_2)
      ).to.be.revertedWith("Settlement: already settled");
    });
  });

  // ─────────────────────────────────────────────
  //  verifySettlementRecord
  // ─────────────────────────────────────────────

  describe("verifySettlementRecord", function () {
    beforeEach(async function () {
      await settlement.connect(operator).submitSettlement(TOURNAMENT_ID, RESULT_HASH);
    });

    it("operator (default verifier) can verify a settlement", async function () {
      await expect(settlement.connect(operator).verifySettlementRecord(TOURNAMENT_ID))
        .to.emit(settlement, "SettlementVerified")
        .withArgs(TOURNAMENT_ID, operator.address);

      expect(await settlement.isVerified(TOURNAMENT_ID)).to.be.true;
    });

    it("custom verifier can verify a settlement", async function () {
      await settlement.connect(owner).setVerifier(verifier.address);
      await expect(settlement.connect(verifier).verifySettlementRecord(TOURNAMENT_ID))
        .to.emit(settlement, "SettlementVerified")
        .withArgs(TOURNAMENT_ID, verifier.address);
    });

    it("owner can also verify", async function () {
      await expect(settlement.connect(owner).verifySettlementRecord(TOURNAMENT_ID))
        .to.emit(settlement, "SettlementVerified")
        .withArgs(TOURNAMENT_ID, owner.address);
    });

    it("reverts if caller is not verifier/operator/owner", async function () {
      await expect(
        settlement.connect(stranger).verifySettlementRecord(TOURNAMENT_ID)
      ).to.be.revertedWith("Settlement: caller is not the verifier");
    });

    it("reverts for un-settled tournament", async function () {
      await expect(
        settlement.connect(operator).verifySettlementRecord(999n)
      ).to.be.revertedWith("Settlement: tournament not settled");
    });

    it("reverts on double verification", async function () {
      await settlement.connect(operator).verifySettlementRecord(TOURNAMENT_ID);
      await expect(
        settlement.connect(operator).verifySettlementRecord(TOURNAMENT_ID)
      ).to.be.revertedWith("Settlement: already verified");
    });
  });

  // ─────────────────────────────────────────────
  //  disputeSettlement
  // ─────────────────────────────────────────────

  describe("disputeSettlement", function () {
    beforeEach(async function () {
      await settlement.connect(operator).submitSettlement(TOURNAMENT_ID, RESULT_HASH);
    });

    it("operator can dispute a settlement", async function () {
      await expect(
        settlement.connect(operator).disputeSettlement(TOURNAMENT_ID, "Scores were incorrect")
      )
        .to.emit(settlement, "SettlementDisputed")
        .withArgs(TOURNAMENT_ID, operator.address, "Scores were incorrect");
    });

    it("dispute does not remove the settlement record", async function () {
      await settlement.connect(operator).disputeSettlement(TOURNAMENT_ID, "Dispute reason");
      expect(await settlement.isSettled(TOURNAMENT_ID)).to.be.true;
    });

    it("reverts if caller is not operator", async function () {
      await expect(
        settlement.connect(stranger).disputeSettlement(TOURNAMENT_ID, "Hack")
      ).to.be.revertedWith("Settlement: caller is not the operator");
    });

    it("reverts for un-settled tournament", async function () {
      await expect(
        settlement.connect(operator).disputeSettlement(999n, "Reason")
      ).to.be.revertedWith("Settlement: tournament not settled");
    });
  });

  // ─────────────────────────────────────────────
  //  getSettlementHash
  // ─────────────────────────────────────────────

  describe("getSettlementHash", function () {
    it("returns correct hash after submission", async function () {
      await settlement.connect(operator).submitSettlement(TOURNAMENT_ID, RESULT_HASH);
      expect(await settlement.getSettlementHash(TOURNAMENT_ID)).to.equal(RESULT_HASH);
    });

    it("reverts for un-settled tournament", async function () {
      await expect(settlement.getSettlementHash(999n)).to.be.revertedWith(
        "Settlement: tournament not settled"
      );
    });
  });

  // ─────────────────────────────────────────────
  //  isSettled / isVerified
  // ─────────────────────────────────────────────

  describe("isSettled / isVerified", function () {
    it("isSettled returns false before submission", async function () {
      expect(await settlement.isSettled(TOURNAMENT_ID)).to.be.false;
    });

    it("isSettled returns true after submission", async function () {
      await settlement.connect(operator).submitSettlement(TOURNAMENT_ID, RESULT_HASH);
      expect(await settlement.isSettled(TOURNAMENT_ID)).to.be.true;
    });

    it("isVerified returns false before verification", async function () {
      await settlement.connect(operator).submitSettlement(TOURNAMENT_ID, RESULT_HASH);
      expect(await settlement.isVerified(TOURNAMENT_ID)).to.be.false;
    });

    it("isVerified returns true after verification", async function () {
      await settlement.connect(operator).submitSettlement(TOURNAMENT_ID, RESULT_HASH);
      await settlement.connect(operator).verifySettlementRecord(TOURNAMENT_ID);
      expect(await settlement.isVerified(TOURNAMENT_ID)).to.be.true;
    });
  });

  // ─────────────────────────────────────────────
  //  getSettlementMeta
  // ─────────────────────────────────────────────

  describe("getSettlementMeta", function () {
    it("returns correct submitter and timestamp", async function () {
      const tx = await settlement
        .connect(operator)
        .submitSettlement(TOURNAMENT_ID, RESULT_HASH);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      const [submitter, timestamp] = await settlement.getSettlementMeta(TOURNAMENT_ID);
      expect(submitter).to.equal(operator.address);
      expect(timestamp).to.equal(BigInt(block!.timestamp));
    });

    it("reverts for un-settled tournament", async function () {
      await expect(settlement.getSettlementMeta(999n)).to.be.revertedWith(
        "Settlement: tournament not settled"
      );
    });
  });
});
