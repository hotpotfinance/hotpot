pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import "./upgrade/Pausable.sol";
import "./upgrade/ReentrancyGuard.sol";
import "./IStakingRewards.sol";
import "./IConverter.sol";

// Modified from https://docs.synthetix.io/contracts/source/contracts/stakingrewards
/// @title A wrapper contract over StakingRewards contract that allows single asset in/out.
/// 1. User provide token0 or token1
/// 2. contract converts half to the other token and provide liquidity
/// 3. stake into underlying StakingRewards contract
/// @notice Asset tokens are token0 and token1. Staking token is the LP token of token0/token1.
abstract contract BaseSingleTokenStaking is ReentrancyGuard, Pausable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    /* ========== STATE VARIABLES ========== */

    string public name;
    IConverter public converter;
    IERC20 public lp;
    IERC20 public token0;
    IERC20 public token1;

    IStakingRewards public stakingRewards;
    bool public isToken0RewardsToken;

    /// @dev Piggyback on StakingRewards' reward accounting
    mapping(address => uint256) internal _userRewardPerTokenPaid;
    mapping(address => uint256) internal _rewards;

    uint256 internal _totalSupply;
    mapping(address => uint256) internal _balances;

    /* ========== VIEWS ========== */

    /// @dev Get the implementation contract of this proxy contract.
    /// Only to be used on the proxy contract. Otherwise it would return zero address.
    function implementation() external view returns (address) {
        return _getImplementation();
    }

    function totalSupply() external view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    /// @notice Get the reward earned by specified account.
    function earned(address account) public virtual view returns (uint256) {}

    /* ========== MUTATIVE FUNCTIONS ========== */

    function _convertAndAddLiquidity(bool isToken0, uint256 amount) internal returns (uint256 lpAmount) {
        require(amount > 0, "Cannot stake 0");
        uint256 lpAmountBefore = lp.balanceOf(address(this));
        uint256 token0AmountBefore = token0.balanceOf(address(this));
        uint256 token1AmountBefore = token1.balanceOf(address(this));

        // Convert and add liquidity
        uint256 prevBalance;
        uint256 postBalance;
        uint256 actualAmount;
        if (isToken0) {
            prevBalance = token0.balanceOf(address(this));
            token0.safeTransferFrom(msg.sender, address(this), amount);
            postBalance = token0.balanceOf(address(this));
            actualAmount = postBalance - prevBalance;
            
            token0.safeApprove(address(converter), actualAmount);
            converter.convertAndAddLiquidity(address(token0), actualAmount, address(token1), 0, address(this));
        } else {
            prevBalance = token1.balanceOf(address(this));
            token1.safeTransferFrom(msg.sender, address(this), amount);
            postBalance = token1.balanceOf(address(this));
            actualAmount = postBalance - prevBalance;

            token1.safeApprove(address(converter), actualAmount);
            converter.convertAndAddLiquidity(address(token1), actualAmount, address(token0), 0, address(this));
        }

        uint256 lpAmountAfter = lp.balanceOf(address(this));
        uint256 token0AmountAfter = token0.balanceOf(address(this));
        uint256 token1AmountAfter = token1.balanceOf(address(this));

        lpAmount = (lpAmountAfter - lpAmountBefore);

        // Return leftover token to msg.sender
        if ((token0AmountAfter - token0AmountBefore) > 0) {
            token0.safeTransfer(msg.sender, (token0AmountAfter - token0AmountBefore));
        }
        if ((token1AmountAfter - token1AmountBefore) > 0) {
            token1.safeTransfer(msg.sender, (token1AmountAfter - token1AmountBefore));
        }
    }

    /// @notice Taken token0 or token1 in, convert half to the other token, provide liquidity and stake
    /// the LP tokens into StakingRewards contract. Leftover token0 or token1 will be returned to msg.sender.
    /// @param isToken0 Determine if token0 is the token msg.sender going to use for staking, token1 otherwise
    /// @param amount Amount of token0 or token1 to stake
    function stake(bool isToken0, uint256 amount) public virtual nonReentrant notPaused updateReward(msg.sender) {
        uint256 lpAmount = _convertAndAddLiquidity(isToken0, amount);
        lp.safeApprove(address(stakingRewards), lpAmount);
        stakingRewards.stake(lpAmount);

        // Top up msg.sender's balance
        _totalSupply = _totalSupply + lpAmount;
        _balances[msg.sender] = _balances[msg.sender] + lpAmount;
        emit Staked(msg.sender, lpAmount);
    }

    /// @notice Withdraw stake from StakingRewards, remove liquidity and convert one asset to another.
    function withdraw(uint256 token0Percentage, uint256 amount) public virtual nonReentrant updateReward(msg.sender) {}

    /// @notice Get the reward out and convert one asset to another.
    function getReward(uint256 token0Percentage) public virtual updateReward(msg.sender) {}

    /// @notice Withdraw all stake from StakingRewards, remove liquidity, get the reward out and convert one asset to another.
    function exit(uint256 token0Percentage) external virtual {}

    /* ========== RESTRICTED FUNCTIONS ========== */

    function recoverERC20(address tokenAddress, uint256 tokenAmount) external onlyOwner {
        require(tokenAddress != address(lp), "Cannot withdraw the staking token");
        IERC20(tokenAddress).safeTransfer(owner, tokenAmount);
        emit Recovered(tokenAddress, tokenAmount);
    }

    function _authorizeUpgrade(address newImplementation) internal view override onlyOwner {}

    /* ========== MODIFIERS ========== */

    modifier updateReward(address account) virtual {
        uint256 rewardPerTokenStored = stakingRewards.rewardPerToken();
        if (account != address(0)) {
            _rewards[account] = earned(account);
            _userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    /* ========== EVENTS ========== */

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Recovered(address token, uint256 amount);
}