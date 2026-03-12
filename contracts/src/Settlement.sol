// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title Settlement
 * @notice Records tournament results on-chain for auditability.
 *
 *         The backend operator submits a keccak256 hash of the full
 *         result payload (participants, scores, winners) after a
 *         tournament finishes. Anyone can verify the hash against
 *         off-chain data.
 *
 *         A second privileged verifier role (defaulting to the operator)
 *         can mark a settlement as "verified" after additional validation.
 */
contract Settlement is Ownable {
    // ─────────────────────────────────────────────
    //  Types
    // ─────────────────────────────────────────────

    struct SettlementRecord {
        uint256 tournamentId;
        bytes32 resultHash;     // keccak256 of off-chain result payload
        address submitter;
        uint256 timestamp;
        bool    verified;       // set by the verifier after validation
    }

    // ─────────────────────────────────────────────
    //  State
    // ─────────────────────────────────────────────

    /// @notice The privileged backend operator.
    address public operator;

    /// @notice An optional second verifier (can be the same as operator).
    address public verifier;

    /// @notice tournamentId => SettlementRecord
    mapping(uint256 => SettlementRecord) private _settlements;

    /// @notice Track which tournamentIds have been settled.
    mapping(uint256 => bool) private _settled;

    // ─────────────────────────────────────────────
    //  Events
    // ─────────────────────────────────────────────

    event OperatorSet(address indexed previousOperator, address indexed newOperator);
    event VerifierSet(address indexed previousVerifier, address indexed newVerifier);
    event SettlementSubmitted(
        uint256 indexed tournamentId,
        bytes32 indexed resultHash,
        address indexed submitter,
        uint256 timestamp
    );
    event SettlementVerified(uint256 indexed tournamentId, address indexed verifiedBy);
    event SettlementDisputed(uint256 indexed tournamentId, address indexed disputedBy, string reason);

    // ─────────────────────────────────────────────
    //  Modifiers
    // ─────────────────────────────────────────────

    modifier onlyOperator() {
        require(msg.sender == operator, "Settlement: caller is not the operator");
        _;
    }

    modifier onlyVerifier() {
        require(
            msg.sender == verifier || msg.sender == operator || msg.sender == owner(),
            "Settlement: caller is not the verifier"
        );
        _;
    }

    modifier settlementExists(uint256 tournamentId) {
        require(_settled[tournamentId], "Settlement: tournament not settled");
        _;
    }

    // ─────────────────────────────────────────────
    //  Constructor
    // ─────────────────────────────────────────────

    /**
     * @param initialOwner      Contract owner.
     * @param initialOperator   Backend operator that submits settlements.
     */
    constructor(address initialOwner, address initialOperator) Ownable(initialOwner) {
        require(initialOperator != address(0), "Settlement: operator is zero address");
        operator = initialOperator;
        verifier = initialOperator;

        emit OperatorSet(address(0), initialOperator);
        emit VerifierSet(address(0), initialOperator);
    }

    // ─────────────────────────────────────────────
    //  Admin
    // ─────────────────────────────────────────────

    /**
     * @notice Replace the backend operator.
     * @param newOperator New operator address.
     */
    function setOperator(address newOperator) external onlyOwner {
        require(newOperator != address(0), "Settlement: operator is zero address");
        address previous = operator;
        operator = newOperator;
        emit OperatorSet(previous, newOperator);
    }

    /**
     * @notice Replace the verifier.
     * @param newVerifier New verifier address.
     */
    function setVerifier(address newVerifier) external onlyOwner {
        require(newVerifier != address(0), "Settlement: verifier is zero address");
        address previous = verifier;
        verifier = newVerifier;
        emit VerifierSet(previous, newVerifier);
    }

    // ─────────────────────────────────────────────
    //  Operator actions
    // ─────────────────────────────────────────────

    /**
     * @notice Submit a tournament result on-chain.
     * @param tournamentId  Unique tournament identifier.
     * @param resultHash    keccak256 hash of the full off-chain result payload.
     *
     * Requirements:
     * - Tournament must not already be settled.
     * - resultHash must be non-zero.
     */
    function submitSettlement(uint256 tournamentId, bytes32 resultHash)
        external
        onlyOperator
    {
        require(!_settled[tournamentId], "Settlement: already settled");
        require(resultHash != bytes32(0), "Settlement: resultHash is zero");

        _settlements[tournamentId] = SettlementRecord({
            tournamentId: tournamentId,
            resultHash: resultHash,
            submitter: msg.sender,
            timestamp: block.timestamp,
            verified: false
        });
        _settled[tournamentId] = true;

        emit SettlementSubmitted(tournamentId, resultHash, msg.sender, block.timestamp);
    }

    /**
     * @notice Mark a settlement as verified after off-chain validation.
     * @param tournamentId The tournament to verify.
     */
    function verifySettlementRecord(uint256 tournamentId)
        external
        onlyVerifier
        settlementExists(tournamentId)
    {
        require(!_settlements[tournamentId].verified, "Settlement: already verified");
        _settlements[tournamentId].verified = true;
        emit SettlementVerified(tournamentId, msg.sender);
    }

    /**
     * @notice Flag a settlement as disputed (does not remove record).
     *         Dispute resolution is handled off-chain; this creates an
     *         on-chain audit trail.
     * @param tournamentId The tournament under dispute.
     * @param reason       Human-readable reason string.
     */
    function disputeSettlement(uint256 tournamentId, string calldata reason)
        external
        onlyOperator
        settlementExists(tournamentId)
    {
        emit SettlementDisputed(tournamentId, msg.sender, reason);
    }

    // ─────────────────────────────────────────────
    //  View functions
    // ─────────────────────────────────────────────

    /**
     * @notice Return the full settlement record.
     * @param tournamentId The tournament identifier.
     * @return record The SettlementRecord struct.
     */
    function verifySettlement(uint256 tournamentId)
        external
        view
        settlementExists(tournamentId)
        returns (SettlementRecord memory record)
    {
        return _settlements[tournamentId];
    }

    /**
     * @notice Return only the result hash for a tournament.
     * @param tournamentId The tournament identifier.
     * @return hash The keccak256 result hash.
     */
    function getSettlementHash(uint256 tournamentId)
        external
        view
        settlementExists(tournamentId)
        returns (bytes32 hash)
    {
        return _settlements[tournamentId].resultHash;
    }

    /**
     * @notice Check whether a tournament has been settled.
     * @param tournamentId The tournament identifier.
     * @return settled True if a settlement record exists.
     */
    function isSettled(uint256 tournamentId) external view returns (bool settled) {
        return _settled[tournamentId];
    }

    /**
     * @notice Check whether a settlement has been verified.
     * @param tournamentId The tournament identifier.
     * @return verified True if verified.
     */
    function isVerified(uint256 tournamentId)
        external
        view
        settlementExists(tournamentId)
        returns (bool verified)
    {
        return _settlements[tournamentId].verified;
    }

    /**
     * @notice Return the submitter and timestamp of a settlement.
     * @param tournamentId The tournament identifier.
     * @return submitter  The address that submitted the settlement.
     * @return timestamp  Block timestamp at submission.
     */
    function getSettlementMeta(uint256 tournamentId)
        external
        view
        settlementExists(tournamentId)
        returns (address submitter, uint256 timestamp)
    {
        SettlementRecord storage r = _settlements[tournamentId];
        return (r.submitter, r.timestamp);
    }
}
