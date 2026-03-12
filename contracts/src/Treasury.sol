// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./AgentRegistry.sol";

/**
 * @title Treasury
 * @notice Holds platform ETH (prize pools, entry fees, revenue) and
 *         allows the backend operator to transfer funds to agent hot-wallets.
 *
 *         Deposits are permissionless; withdrawals and agent transfers are
 *         access-controlled.
 */
contract Treasury is Ownable, ReentrancyGuard {
    // ─────────────────────────────────────────────
    //  State
    // ─────────────────────────────────────────────

    AgentRegistry public immutable registry;

    /// @notice The privileged backend operator.
    address public operator;

    // ─────────────────────────────────────────────
    //  Events
    // ─────────────────────────────────────────────

    event OperatorSet(address indexed previousOperator, address indexed newOperator);
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event TransferredToAgent(bytes32 indexed agentId, address indexed hotWallet, uint256 amount);

    // ─────────────────────────────────────────────
    //  Modifiers
    // ─────────────────────────────────────────────

    modifier onlyOperator() {
        require(msg.sender == operator, "Treasury: caller is not the operator");
        _;
    }

    // ─────────────────────────────────────────────
    //  Constructor
    // ─────────────────────────────────────────────

    /**
     * @param initialOwner      Contract owner (multisig / deployer).
     * @param agentRegistry     Deployed AgentRegistry address.
     * @param initialOperator   Backend operator address.
     */
    constructor(
        address initialOwner,
        address agentRegistry,
        address initialOperator
    ) Ownable(initialOwner) {
        require(agentRegistry != address(0), "Treasury: registry is zero address");
        require(initialOperator != address(0), "Treasury: operator is zero address");

        registry = AgentRegistry(agentRegistry);
        operator = initialOperator;

        emit OperatorSet(address(0), initialOperator);
    }

    // ─────────────────────────────────────────────
    //  Admin
    // ─────────────────────────────────────────────

    /**
     * @notice Replace the backend operator.
     * @param newOperator New operator address.
     */
    function setOperator(address newOperator) external onlyOwner {
        require(newOperator != address(0), "Treasury: operator is zero address");
        address previous = operator;
        operator = newOperator;
        emit OperatorSet(previous, newOperator);
    }

    // ─────────────────────────────────────────────
    //  Deposit
    // ─────────────────────────────────────────────

    /**
     * @notice Deposit ETH into the treasury.
     *         Can be called by anyone (game contracts, players, etc.).
     */
    function deposit() external payable {
        require(msg.value > 0, "Treasury: deposit must be > 0");
        emit Deposited(msg.sender, msg.value);
    }

    // ─────────────────────────────────────────────
    //  Owner actions
    // ─────────────────────────────────────────────

    /**
     * @notice Withdraw ETH from the treasury to the owner.
     * @param amount Amount in wei to withdraw.
     */
    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "Treasury: amount must be > 0");
        require(address(this).balance >= amount, "Treasury: insufficient balance");

        (bool success, ) = payable(owner()).call{value: amount}("");
        require(success, "Treasury: ETH transfer failed");

        emit Withdrawn(owner(), amount);
    }

    // ─────────────────────────────────────────────
    //  Operator actions
    // ─────────────────────────────────────────────

    /**
     * @notice Transfer ETH from the treasury to an agent's hot-wallet.
     *         Used to fund prize payouts, rewards, etc.
     * @param agentId The recipient agent identifier.
     * @param amount  Amount in wei to transfer.
     *
     * Requirements:
     * - Agent must be registered and active
     * - Agent must have a hot-wallet set
     * - Treasury must have sufficient balance
     */
    function transferToAgent(bytes32 agentId, uint256 amount)
        external
        onlyOperator
        nonReentrant
    {
        require(amount > 0, "Treasury: amount must be > 0");
        require(address(this).balance >= amount, "Treasury: insufficient balance");

        AgentRegistry.Agent memory agent = registry.getAgent(agentId);
        require(agent.isActive, "Treasury: agent is not active");
        require(agent.hotWallet != address(0), "Treasury: agent has no hot wallet");

        (bool success, ) = payable(agent.hotWallet).call{value: amount}("");
        require(success, "Treasury: ETH transfer to agent failed");

        emit TransferredToAgent(agentId, agent.hotWallet, amount);
    }

    /**
     * @notice Transfer ETH to an arbitrary address (e.g. agent owner if no
     *         hot-wallet is set). Uses owner or hotWallet based on agent state.
     * @param agentId The recipient agent identifier.
     * @param amount  Amount in wei to transfer.
     * @param useOwner If true, sends to agent.owner; otherwise to agent.hotWallet.
     */
    function transferToAgentAddress(bytes32 agentId, uint256 amount, bool useOwner)
        external
        onlyOperator
        nonReentrant
    {
        require(amount > 0, "Treasury: amount must be > 0");
        require(address(this).balance >= amount, "Treasury: insufficient balance");

        AgentRegistry.Agent memory agent = registry.getAgent(agentId);
        require(agent.isActive, "Treasury: agent is not active");

        address recipient = useOwner ? agent.owner : agent.hotWallet;
        require(recipient != address(0), "Treasury: recipient is zero address");

        (bool success, ) = payable(recipient).call{value: amount}("");
        require(success, "Treasury: ETH transfer failed");

        emit TransferredToAgent(agentId, recipient, amount);
    }

    // ─────────────────────────────────────────────
    //  View functions
    // ─────────────────────────────────────────────

    /**
     * @notice Return the current ETH balance held by the treasury.
     * @return balance Balance in wei.
     */
    function getBalance() external view returns (uint256 balance) {
        return address(this).balance;
    }

    // ─────────────────────────────────────────────
    //  Receive / Fallback
    // ─────────────────────────────────────────────

    /// @dev Accept direct ETH transfers (e.g. from game contracts).
    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    fallback() external payable {
        emit Deposited(msg.sender, msg.value);
    }
}
