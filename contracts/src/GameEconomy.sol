// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./AgentRegistry.sol";

/**
 * @title GameEconomy
 * @notice Handles weapon purchases and upgrades for AI agents in the
 *         KULT platform. Payments are made in native ETH (or chain gas
 *         token). Only an agent's registered hot-wallet may transact on
 *         its behalf.
 */
contract GameEconomy is Ownable, ReentrancyGuard {
    // ─────────────────────────────────────────────
    //  Types
    // ─────────────────────────────────────────────

    struct Weapon {
        uint256 weaponId;
        string  name;
        uint256 baseCost;   // in wei
        bool    isActive;
    }

    struct AgentWeaponInfo {
        bool    owned;
        uint256 level;      // 0 = not upgraded, 1+ = upgrade count
    }

    // ─────────────────────────────────────────────
    //  State
    // ─────────────────────────────────────────────

    AgentRegistry public immutable registry;

    /// @notice weaponId => Weapon
    mapping(uint256 => Weapon) private _weapons;

    /// @notice agentId => weaponId => owned
    mapping(bytes32 => mapping(uint256 => bool)) private _agentOwnsWeapon;

    /// @notice agentId => weaponId => upgrade level
    mapping(bytes32 => mapping(uint256 => uint256)) private _agentWeaponLevel;

    /// @notice Track valid weaponIds
    uint256[] private _weaponIds;
    mapping(uint256 => bool) private _weaponExists;

    // Upgrade cost multiplier basis points (150 = 1.5x per level)
    uint256 public constant UPGRADE_MULTIPLIER_BPS = 150;
    uint256 public constant BPS_DENOMINATOR = 100;

    // ─────────────────────────────────────────────
    //  Events
    // ─────────────────────────────────────────────

    event WeaponAdded(uint256 indexed weaponId, string name, uint256 baseCost);
    event WeaponUpdated(uint256 indexed weaponId, string name, uint256 baseCost, bool isActive);
    event WeaponPurchased(bytes32 indexed agentId, uint256 indexed weaponId, address indexed hotWallet, uint256 pricePaid);
    event WeaponUpgraded(bytes32 indexed agentId, uint256 indexed weaponId, uint256 newLevel, uint256 pricePaid);
    event Withdrawn(address indexed to, uint256 amount);

    // ─────────────────────────────────────────────
    //  Constructor
    // ─────────────────────────────────────────────

    /**
     * @param initialOwner    Contract owner (multisig / deployer).
     * @param agentRegistry   Deployed AgentRegistry address.
     */
    constructor(address initialOwner, address agentRegistry) Ownable(initialOwner) {
        require(agentRegistry != address(0), "GameEconomy: registry is zero address");
        registry = AgentRegistry(agentRegistry);
    }

    // ─────────────────────────────────────────────
    //  Internal helpers
    // ─────────────────────────────────────────────

    /**
     * @dev Verify msg.sender is the hot-wallet registered to agentId.
     *      Falls back to checking the owner if no hot-wallet is set.
     */
    function _requireCallerIsAgent(bytes32 agentId) internal view {
        AgentRegistry.Agent memory agent = registry.getAgent(agentId);
        require(agent.isActive, "GameEconomy: agent is not active");

        address authorized = agent.hotWallet != address(0) ? agent.hotWallet : agent.owner;
        require(msg.sender == authorized, "GameEconomy: caller is not agent hot-wallet");
    }

    /**
     * @dev Calculate the upgrade cost for the NEXT level.
     *      Cost = baseCost * (UPGRADE_MULTIPLIER_BPS / BPS_DENOMINATOR) ^ currentLevel
     *      Implemented iteratively to avoid floating point.
     *      level 0 -> 1 : baseCost * 1.5
     *      level 1 -> 2 : baseCost * 1.5^2 = baseCost * 2.25
     *      etc.
     */
    function _upgradeCost(uint256 baseCost, uint256 currentLevel) internal pure returns (uint256 cost) {
        // Start from baseCost, apply multiplier (currentLevel + 1) times.
        // We work in integer arithmetic:
        //   cost = baseCost * (3/2)^n   where n = currentLevel + 1
        // Using BPS: multiply by 150 and divide by 100 each iteration.
        cost = baseCost;
        uint256 times = currentLevel + 1;
        for (uint256 i = 0; i < times; i++) {
            cost = (cost * UPGRADE_MULTIPLIER_BPS) / BPS_DENOMINATOR;
        }
    }

    // ─────────────────────────────────────────────
    //  Owner actions
    // ─────────────────────────────────────────────

    /**
     * @notice Add a new weapon to the shop.
     * @param weaponId  Unique numeric weapon identifier.
     * @param name      Human-readable weapon name.
     * @param baseCost  Base purchase cost in wei.
     */
    function addWeapon(
        uint256 weaponId,
        string calldata name,
        uint256 baseCost
    ) external onlyOwner {
        require(!_weaponExists[weaponId], "GameEconomy: weapon already exists");
        require(baseCost > 0, "GameEconomy: baseCost must be > 0");
        require(bytes(name).length > 0, "GameEconomy: name cannot be empty");

        _weapons[weaponId] = Weapon({
            weaponId: weaponId,
            name: name,
            baseCost: baseCost,
            isActive: true
        });
        _weaponExists[weaponId] = true;
        _weaponIds.push(weaponId);

        emit WeaponAdded(weaponId, name, baseCost);
    }

    /**
     * @notice Update an existing weapon's details.
     * @param weaponId  The weapon to update.
     * @param name      New name (pass empty string to keep existing).
     * @param baseCost  New base cost in wei (pass 0 to keep existing).
     * @param isActive  Whether the weapon is available for purchase.
     */
    function updateWeapon(
        uint256 weaponId,
        string calldata name,
        uint256 baseCost,
        bool isActive
    ) external onlyOwner {
        require(_weaponExists[weaponId], "GameEconomy: weapon does not exist");

        Weapon storage w = _weapons[weaponId];
        if (bytes(name).length > 0) w.name = name;
        if (baseCost > 0) w.baseCost = baseCost;
        w.isActive = isActive;

        emit WeaponUpdated(weaponId, w.name, w.baseCost, isActive);
    }

    /**
     * @notice Withdraw accumulated ETH from weapon sales.
     */
    function withdraw() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        require(balance > 0, "GameEconomy: nothing to withdraw");
        (bool success, ) = payable(owner()).call{value: balance}("");
        require(success, "GameEconomy: ETH transfer failed");
        emit Withdrawn(owner(), balance);
    }

    // ─────────────────────────────────────────────
    //  Agent actions
    // ─────────────────────────────────────────────

    /**
     * @notice Purchase a weapon for an agent.
     * @param agentId   The agent buying the weapon.
     * @param weaponId  The weapon to purchase.
     *
     * Requirements:
     * - msg.sender must be the agent's hot-wallet (or owner if none set)
     * - weapon must exist and be active
     * - msg.value must be >= weapon baseCost
     * - agent must not already own the weapon
     */
    function buyWeapon(bytes32 agentId, uint256 weaponId)
        external
        payable
        nonReentrant
    {
        _requireCallerIsAgent(agentId);

        require(_weaponExists[weaponId], "GameEconomy: weapon does not exist");
        Weapon storage w = _weapons[weaponId];
        require(w.isActive, "GameEconomy: weapon is not active");
        require(!_agentOwnsWeapon[agentId][weaponId], "GameEconomy: agent already owns weapon");
        require(msg.value >= w.baseCost, "GameEconomy: insufficient payment");

        _agentOwnsWeapon[agentId][weaponId] = true;
        _agentWeaponLevel[agentId][weaponId] = 0;

        // Refund overpayment
        uint256 excess = msg.value - w.baseCost;
        if (excess > 0) {
            (bool refunded, ) = payable(msg.sender).call{value: excess}("");
            require(refunded, "GameEconomy: refund failed");
        }

        emit WeaponPurchased(agentId, weaponId, msg.sender, w.baseCost);
    }

    /**
     * @notice Upgrade an owned weapon for an agent.
     * @param agentId   The agent upgrading the weapon.
     * @param weaponId  The weapon to upgrade.
     *
     * Upgrade cost = baseCost * 1.5^(currentLevel+1)
     *
     * Requirements:
     * - msg.sender must be the agent's hot-wallet (or owner if none set)
     * - agent must own the weapon
     * - msg.value must be >= upgrade cost
     */
    function upgradeWeapon(bytes32 agentId, uint256 weaponId)
        external
        payable
        nonReentrant
    {
        _requireCallerIsAgent(agentId);

        require(_weaponExists[weaponId], "GameEconomy: weapon does not exist");
        require(_agentOwnsWeapon[agentId][weaponId], "GameEconomy: agent does not own weapon");

        uint256 currentLevel = _agentWeaponLevel[agentId][weaponId];
        uint256 cost = _upgradeCost(_weapons[weaponId].baseCost, currentLevel);

        require(msg.value >= cost, "GameEconomy: insufficient upgrade payment");

        _agentWeaponLevel[agentId][weaponId] = currentLevel + 1;

        // Refund overpayment
        uint256 excess = msg.value - cost;
        if (excess > 0) {
            (bool refunded, ) = payable(msg.sender).call{value: excess}("");
            require(refunded, "GameEconomy: refund failed");
        }

        emit WeaponUpgraded(agentId, weaponId, currentLevel + 1, cost);
    }

    // ─────────────────────────────────────────────
    //  View functions
    // ─────────────────────────────────────────────

    /**
     * @notice Return a weapon's details.
     * @param weaponId The weapon identifier.
     * @return weapon The Weapon struct.
     */
    function getWeapon(uint256 weaponId) external view returns (Weapon memory weapon) {
        require(_weaponExists[weaponId], "GameEconomy: weapon does not exist");
        return _weapons[weaponId];
    }

    /**
     * @notice Return ownership and upgrade level for an agent's weapon.
     * @param agentId  The agent identifier.
     * @param weaponId The weapon identifier.
     * @return owned   True if the agent owns the weapon.
     * @return level   Current upgrade level (0 = base, no upgrades).
     */
    function getAgentWeapon(bytes32 agentId, uint256 weaponId)
        external
        view
        returns (bool owned, uint256 level)
    {
        owned = _agentOwnsWeapon[agentId][weaponId];
        level = _agentWeaponLevel[agentId][weaponId];
    }

    /**
     * @notice Return the next upgrade cost for a weapon an agent owns.
     * @param agentId  The agent identifier.
     * @param weaponId The weapon identifier.
     * @return cost The cost in wei for the next upgrade.
     */
    function getNextUpgradeCost(bytes32 agentId, uint256 weaponId)
        external
        view
        returns (uint256 cost)
    {
        require(_weaponExists[weaponId], "GameEconomy: weapon does not exist");
        require(_agentOwnsWeapon[agentId][weaponId], "GameEconomy: agent does not own weapon");
        uint256 currentLevel = _agentWeaponLevel[agentId][weaponId];
        return _upgradeCost(_weapons[weaponId].baseCost, currentLevel);
    }

    /**
     * @notice Return all registered weapon IDs.
     * @return ids Array of weapon IDs.
     */
    function getAllWeaponIds() external view returns (uint256[] memory ids) {
        return _weaponIds;
    }

    /**
     * @notice Return the contract's ETH balance.
     * @return balance Balance in wei.
     */
    function getBalance() external view returns (uint256 balance) {
        return address(this).balance;
    }

    // ─────────────────────────────────────────────
    //  Receive
    // ─────────────────────────────────────────────

    receive() external payable {}
}
