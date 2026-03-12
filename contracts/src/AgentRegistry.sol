// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title AgentRegistry
 * @notice Registry for AI agents in the KULT gaming platform.
 *         The backend operator registers agents on-chain; each agent
 *         has an owner (EOA) and an optional hot-wallet for in-game
 *         transactions.
 */
contract AgentRegistry is Ownable {
    // ─────────────────────────────────────────────
    //  Types
    // ─────────────────────────────────────────────

    struct Agent {
        address owner;
        address hotWallet;
        bool    isActive;
        uint256 registeredAt;
    }

    // ─────────────────────────────────────────────
    //  State
    // ─────────────────────────────────────────────

    /// @notice The privileged backend operator that can register agents.
    address public operator;

    /// @notice agentId => Agent record.
    mapping(bytes32 => Agent) private _agents;

    /// @notice Tracks which agentIds have ever been registered (non-zero owner).
    mapping(bytes32 => bool) private _exists;

    // ─────────────────────────────────────────────
    //  Events
    // ─────────────────────────────────────────────

    event OperatorSet(address indexed previousOperator, address indexed newOperator);
    event AgentRegistered(bytes32 indexed agentId, address indexed owner, uint256 timestamp);
    event WalletUpdated(bytes32 indexed agentId, address indexed previousWallet, address indexed newWallet);
    event AgentTransferred(bytes32 indexed agentId, address indexed previousOwner, address indexed newOwner);
    event AgentDeactivated(bytes32 indexed agentId);
    event AgentActivated(bytes32 indexed agentId);

    // ─────────────────────────────────────────────
    //  Modifiers
    // ─────────────────────────────────────────────

    modifier onlyOperator() {
        require(msg.sender == operator, "AgentRegistry: caller is not the operator");
        _;
    }

    modifier onlyAgentOwner(bytes32 agentId) {
        require(_exists[agentId], "AgentRegistry: agent does not exist");
        require(_agents[agentId].owner == msg.sender, "AgentRegistry: caller is not the agent owner");
        _;
    }

    modifier agentExists(bytes32 agentId) {
        require(_exists[agentId], "AgentRegistry: agent does not exist");
        _;
    }

    // ─────────────────────────────────────────────
    //  Constructor
    // ─────────────────────────────────────────────

    /**
     * @param initialOwner The contract owner (multisig / deployer).
     * @param initialOperator The backend operator address.
     */
    constructor(address initialOwner, address initialOperator) Ownable(initialOwner) {
        require(initialOperator != address(0), "AgentRegistry: operator is zero address");
        operator = initialOperator;
        emit OperatorSet(address(0), initialOperator);
    }

    // ─────────────────────────────────────────────
    //  Admin
    // ─────────────────────────────────────────────

    /**
     * @notice Replace the backend operator.
     * @param newOperator The new operator address.
     */
    function setOperator(address newOperator) external onlyOwner {
        require(newOperator != address(0), "AgentRegistry: operator is zero address");
        address previous = operator;
        operator = newOperator;
        emit OperatorSet(previous, newOperator);
    }

    // ─────────────────────────────────────────────
    //  Operator actions
    // ─────────────────────────────────────────────

    /**
     * @notice Register a new agent. Only callable by the operator.
     * @param agentId  Unique off-chain agent identifier (keccak256 of UUID etc.).
     * @param agentOwner  EOA that will own this agent on-chain.
     */
    function registerAgent(bytes32 agentId, address agentOwner) external onlyOperator {
        require(agentId != bytes32(0), "AgentRegistry: agentId is zero");
        require(agentOwner != address(0), "AgentRegistry: owner is zero address");
        require(!_exists[agentId], "AgentRegistry: agent already registered");

        _agents[agentId] = Agent({
            owner: agentOwner,
            hotWallet: address(0),
            isActive: true,
            registeredAt: block.timestamp
        });
        _exists[agentId] = true;

        emit AgentRegistered(agentId, agentOwner, block.timestamp);
    }

    /**
     * @notice Deactivate an agent (soft-delete). Only callable by operator.
     * @param agentId The agent to deactivate.
     */
    function deactivateAgent(bytes32 agentId) external onlyOperator agentExists(agentId) {
        _agents[agentId].isActive = false;
        emit AgentDeactivated(agentId);
    }

    /**
     * @notice Reactivate a previously deactivated agent.
     * @param agentId The agent to reactivate.
     */
    function activateAgent(bytes32 agentId) external onlyOperator agentExists(agentId) {
        _agents[agentId].isActive = true;
        emit AgentActivated(agentId);
    }

    // ─────────────────────────────────────────────
    //  Agent-owner actions
    // ─────────────────────────────────────────────

    /**
     * @notice Set or replace the hot-wallet for an agent. Only callable by
     *         the agent's current owner.
     * @param agentId   The agent to update.
     * @param hotWallet The new hot-wallet address (can be zero to clear).
     */
    function updateWallet(bytes32 agentId, address hotWallet) external onlyAgentOwner(agentId) {
        address previous = _agents[agentId].hotWallet;
        _agents[agentId].hotWallet = hotWallet;
        emit WalletUpdated(agentId, previous, hotWallet);
    }

    /**
     * @notice Transfer ownership of an agent to a new address.
     * @param agentId  The agent to transfer.
     * @param newOwner The recipient address.
     */
    function transferAgent(bytes32 agentId, address newOwner) external onlyAgentOwner(agentId) {
        require(newOwner != address(0), "AgentRegistry: new owner is zero address");
        address previous = _agents[agentId].owner;
        _agents[agentId].owner = newOwner;
        emit AgentTransferred(agentId, previous, newOwner);
    }

    // ─────────────────────────────────────────────
    //  View functions
    // ─────────────────────────────────────────────

    /**
     * @notice Return the full Agent struct for a given agentId.
     * @param agentId The agent identifier.
     * @return agent The Agent struct.
     */
    function getAgent(bytes32 agentId) external view agentExists(agentId) returns (Agent memory agent) {
        return _agents[agentId];
    }

    /**
     * @notice Return only the hot-wallet of an agent (used by other contracts).
     * @param agentId The agent identifier.
     * @return hotWallet The registered hot-wallet address.
     */
    function getHotWallet(bytes32 agentId) external view agentExists(agentId) returns (address hotWallet) {
        return _agents[agentId].hotWallet;
    }

    /**
     * @notice Return only the owner of an agent.
     * @param agentId The agent identifier.
     * @return agentOwner The owner address.
     */
    function getOwner(bytes32 agentId) external view agentExists(agentId) returns (address agentOwner) {
        return _agents[agentId].owner;
    }

    /**
     * @notice Check whether an agent is registered.
     * @param agentId The agent identifier.
     * @return exists True if registered.
     */
    function isRegistered(bytes32 agentId) external view returns (bool exists) {
        return _exists[agentId];
    }

    /**
     * @notice Check whether an agent is active.
     * @param agentId The agent identifier.
     * @return active True if active.
     */
    function isActive(bytes32 agentId) external view agentExists(agentId) returns (bool active) {
        return _agents[agentId].isActive;
    }
}
