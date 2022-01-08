pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import "../upgrade/Pausable.sol";
import "../upgrade/ReentrancyGuard.sol";
import "../interfaces/IMasterChef.sol";
import "../interfaces/IConverter.sol";
import "../interfaces/IWeth.sol";

// Modified from https://docs.synthetix.io/contracts/source/contracts/stakingrewards
// and adjusted based on https://github.com/pancakeswap/pancake-farm/blob/master/contracts/MasterChef.sol
/// @title A wrapper contract over MasterChef contract that allows single asset in/out.
/// 1. User provide token0 or token1
/// 2. contract converts half to the other token and provide liquidity
/// 3. stake into underlying MasterChef contract
/// @notice Asset tokens are token0 and token1. Staking token is the LP token of token0/token1.
abstract contract BaseSingleTokenStakingCakeFarm is ReentrancyGuard, Pausable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    /* ========== STATE VARIABLES ========== */

    string public name;
    uint256 public pid; //Pool ID in MasterChef
    address public BCNT;
    IERC20 public cake;
    IERC20 public lp;
    IERC20 public token0;
    IERC20 public token1;
    IConverter public converter;
    IMasterChef public masterChef;


    /// @dev Piggyback on MasterChef' reward accounting
    // Info of each user.
    struct UserInfo {
        uint256 amount;     // How many LP tokens the user has provided.
        uint256 rewardDebt; // Reward debt.
        uint256 accruedReward;
    }

    mapping(address => UserInfo) public userInfo;

    /* ========== VIEWS ========== */

    /// @dev Get the implementation contract of this proxy contract.
    /// Only to be used on the proxy contract. Otherwise it would return zero address.
    function implementation() external view returns (address) {
        return _getImplementation();
    }

    function totalSupply() external view returns (uint256) {
        return userInfo[address(this)].amount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return userInfo[account].amount;
    }

    function _debtOf(address account) external view returns (uint256) {
        return userInfo[account].rewardDebt;
    }

    /// @notice Get the reward earned by specified account.
    function earned(address account) public virtual view returns (uint256) {}

    function _getAccCakePerShare() public view returns (uint256) {
        (, , , uint256 accCakePerShare) = masterChef.poolInfo(pid);
        return accCakePerShare;
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    function _convertAndAddLiquidity(
        bool isToken0,
        bool shouldTransferFromSender, 
        uint256 amount,
        uint256 minReceivedTokenAmountSwap,
        uint256 minToken0AmountAddLiq,
        uint256 minToken1AmountAddLiq
    ) internal returns (uint256 lpAmount) {
        require(amount > 0, "Cannot stake 0");
        uint256 lpAmountBefore = lp.balanceOf(address(this));
        uint256 token0AmountBefore = token0.balanceOf(address(this));
        uint256 token1AmountBefore = token1.balanceOf(address(this));

        // Convert and add liquidity
        uint256 prevBalance;
        uint256 postBalance;
        uint256 actualAmount;
        if (isToken0) {
            if (shouldTransferFromSender) {
                prevBalance = token0.balanceOf(address(this));
                token0.safeTransferFrom(msg.sender, address(this), amount);
                postBalance = token0.balanceOf(address(this));
                actualAmount = postBalance - prevBalance;
            } else {
                actualAmount = amount;
            }

            token0.safeApprove(address(converter), actualAmount);
            converter.convertAndAddLiquidity(
                address(token0),
                actualAmount,
                address(token1),
                minReceivedTokenAmountSwap,
                minToken0AmountAddLiq,
                minToken1AmountAddLiq,
                address(this)
            );
        } else {
            if (shouldTransferFromSender) {
                prevBalance = token1.balanceOf(address(this));
                token1.safeTransferFrom(msg.sender, address(this), amount);
                postBalance = token1.balanceOf(address(this));
                actualAmount = postBalance - prevBalance;
            } else {
                actualAmount = amount;
            }

            token1.safeApprove(address(converter), actualAmount);
            converter.convertAndAddLiquidity(
                address(token1),
                actualAmount,
                address(token0),
                minReceivedTokenAmountSwap,
                minToken0AmountAddLiq,
                minToken1AmountAddLiq,
                address(this)
            );
        }

        uint256 lpAmountAfter = lp.balanceOf(address(this));
        uint256 token0AmountAfter = token0.balanceOf(address(this));
        uint256 token1AmountAfter = token1.balanceOf(address(this));

        lpAmount = (lpAmountAfter - lpAmountBefore);

        // Return leftover token to msg.sender
        if (shouldTransferFromSender && (token0AmountAfter - token0AmountBefore) > 0) {
            token0.safeTransfer(msg.sender, (token0AmountAfter - token0AmountBefore));
        }
        if (shouldTransferFromSender && (token1AmountAfter - token1AmountBefore) > 0) {
            token1.safeTransfer(msg.sender, (token1AmountAfter - token1AmountBefore));
        }
    }

    /// @notice Taken token0 or token1 in, convert half to the other token, provide liquidity and stake
    /// the LP tokens into MasterChef contract. Leftover token0 or token1 will be returned to msg.sender.
    /// @param isToken0 Determine if token0 is the token msg.sender going to use for staking, token1 otherwise
    /// @param amount Amount of token0 or token1 to stake
    /// @param minReceivedTokenAmountSwap Minimum amount of token0 or token1 received when swapping one for the other
    /// @param minToken0AmountAddLiq The minimum amount of token0 received when adding liquidity
    /// @param minToken1AmountAddLiq The minimum amount of token1 received when adding liquidity
    function stake(
        bool isToken0,
        uint256 amount,
        uint256 minReceivedTokenAmountSwap,
        uint256 minToken0AmountAddLiq,
        uint256 minToken1AmountAddLiq
    ) public virtual nonReentrant notPaused updateReward(msg.sender) {
        uint256 lpAmount = _convertAndAddLiquidity(isToken0, true, amount, minReceivedTokenAmountSwap, minToken0AmountAddLiq, minToken1AmountAddLiq);
        lp.safeApprove(address(masterChef), lpAmount);
        masterChef.deposit(pid, lpAmount);

        // Top up msg.sender's balance
        userInfo[address(this)].amount = userInfo[address(this)].amount + lpAmount;
        userInfo[msg.sender].amount = userInfo[msg.sender].amount + lpAmount;
        emit Staked(msg.sender, lpAmount);
    }

    /// @notice Take LP tokens and stake into MasterChef contract.
    /// @param lpAmount Amount of LP tokens to stake
    function stakeWithLP(uint256 lpAmount) public nonReentrant notPaused updateReward(msg.sender) {
        lp.safeTransferFrom(msg.sender, address(this), lpAmount);
        lp.safeApprove(address(masterChef), lpAmount);
        masterChef.deposit(pid, lpAmount);

        // Top up msg.sender's balance
        userInfo[address(this)].amount = userInfo[address(this)].amount + lpAmount;
        userInfo[msg.sender].amount = userInfo[msg.sender].amount + lpAmount;
        emit Staked(msg.sender, lpAmount);
    }

    function _validateIsNativeToken() internal view returns (address, bool) {
        address NATIVE_TOKEN = converter.NATIVE_TOKEN();
        bool isToken0 = NATIVE_TOKEN == address(token0);
        require(isToken0 || NATIVE_TOKEN == address(token1), "Native token is not either token0 or token1");
        return (NATIVE_TOKEN, isToken0);
    }

    /// @notice Take native tokens, convert to wrapped native tokens and stake into StakingRewards contract.
    /// @param minReceivedTokenAmountSwap Minimum amount of token0 or token1 received when swapping one for the other
    /// @param minToken0AmountAddLiq The minimum amount of token0 received when adding liquidity
    /// @param minToken1AmountAddLiq The minimum amount of token1 received when adding liquidity
    function stakeWithNative(
        uint256 minReceivedTokenAmountSwap,
        uint256 minToken0AmountAddLiq,
        uint256 minToken1AmountAddLiq
    ) public payable virtual nonReentrant notPaused updateReward(msg.sender) {
        require(msg.value > 0, "No native tokens sent");
        (address NATIVE_TOKEN, bool isToken0) = _validateIsNativeToken();

        IWETH(NATIVE_TOKEN).deposit{ value: msg.value }();
        uint256 lpAmount = _convertAndAddLiquidity(isToken0, false, msg.value, minReceivedTokenAmountSwap, minToken0AmountAddLiq, minToken1AmountAddLiq);
        lp.safeApprove(address(masterChef), lpAmount);
        masterChef.deposit(pid, lpAmount);

        // Top up msg.sender's balance
        userInfo[address(this)].amount = userInfo[address(this)].amount + lpAmount;
        userInfo[msg.sender].amount = userInfo[msg.sender].amount + lpAmount;
        emit Staked(msg.sender, lpAmount);
    }

    /// @notice Withdraw stake from StakingRewards, remove liquidity and convert one asset to another.
    /// @param minToken0AmountConverted The minimum amount of token0 received when removing liquidity
    /// @param minToken1AmountConverted The minimum amount of token1 received when removing liquidity
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    /// @param amount Amount of stake to withdraw
    function withdraw(uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 token0Percentage, uint256 amount) public virtual nonReentrant updateReward(msg.sender) {}

    /// @notice Withdraw LP tokens from MasterChef and return to user.
    /// @param lpAmount Amount of LP tokens to withdraw
    function withdrawWithLP(uint256 lpAmount) public virtual nonReentrant notPaused updateReward(msg.sender) {}

    /// @notice Withdraw stake from StakingRewards, remove liquidity and convert one asset to another.
    /// @param minToken0AmountConverted The minimum amount of token0 received when removing liquidity
    /// @param minToken1AmountConverted The minimum amount of token1 received when removing liquidity
    /// @param amount Amount of stake to withdraw
    function withdrawWithNative(uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 amount) public virtual nonReentrant notPaused updateReward(msg.sender) {}

    /// @notice Get the reward out and convert one asset to another.
    function getReward(uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 minBCNTAmountConverted) public virtual nonReentrant updateReward(msg.sender) {}

    /// @notice Withdraw all stake from MasterChef, remove liquidity and convert to BCNT. Get the reward out and convert one asset to another.
    function exit(uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 minBCNTAmountConverted, uint256 token0Percentage) external virtual {}

    /// @notice Withdraw LP tokens from MasterChef and return to user. Get the reward out and convert one asset to another.
    function exitWithLP(uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 minBCNTAmountConverted) external virtual {}

    /// @notice Withdraw all stake from StakingRewards, remove liquidity, get the reward out and convert one asset to another
    /// @param token0Percentage Determine what percentage of token0 to return to user. Any number between 0 to 100
    /// @param minToken0AmountConverted The minimum amount of token0 received when removing liquidity
    /// @param minToken1AmountConverted The minimum amount of token1 received when removing liquidity
    /// @param minTokenAmountConverted The minimum amount of token0 or token1 received when converting reward token to either one of them
    function exitWithNative(uint256 token0Percentage, uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 minTokenAmountConverted) external virtual {}

    /* ========== RESTRICTED FUNCTIONS ========== */

    function recoverERC20(address tokenAddress, uint256 tokenAmount) external onlyOwner {
        require(tokenAddress != address(lp), "Cannot withdraw the staking token");
        IERC20(tokenAddress).safeTransfer(owner, tokenAmount);
        emit Recovered(tokenAddress, tokenAmount);
    }

    function _authorizeUpgrade(address newImplementation) internal view override onlyOwner {}

    /* ========== MODIFIERS ========== */

    modifier updateReward(address account) virtual {
        masterChef.updatePool(pid);
        uint256 accCakePerShare = _getAccCakePerShare();
        UserInfo storage user = userInfo[account];
        UserInfo storage total = userInfo[address(this)];

        if (account != address(0)) {
            uint256 userPending = user.amount * accCakePerShare / 1e12 - user.rewardDebt;
            user.accruedReward = user.accruedReward + userPending;
            uint256 totalPending = total.amount * accCakePerShare / 1e12 - total.rewardDebt;
            total.accruedReward = total.accruedReward + totalPending;
        }

        _;

        if (account != address(0)) {
            user.rewardDebt = user.amount * accCakePerShare / 1e12;
            total.rewardDebt = total.amount * accCakePerShare / 1e12;
        }
    }

    /* ========== EVENTS ========== */

    event Staked(address indexed user, uint256 amount);
    event Recovered(address token, uint256 amount);
}