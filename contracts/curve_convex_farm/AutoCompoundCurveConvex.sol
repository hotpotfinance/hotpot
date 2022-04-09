pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import "../upgrade/Pausable.sol";
import "../upgrade/ReentrancyGuard.sol";
import "../interfaces/IDepositCompound.sol";
import "../interfaces/IConvexBaseRewardPool.sol";
import "../interfaces/IConvexBooster.sol";
import "../interfaces/IConverterUniV3.sol";
import "../interfaces/IWeth.sol";

// Modified from https://docs.synthetix.io/contracts/source/contracts/stakingrewards
/// @title A wrapper contract over Convex Booster and BaseRewardPool contract that allows single asset in/out.
/// 1. User provide token0 or token1
/// 2. contract converts half to the other token and provide liquidity on Curve
/// 3. stake LP token via Convex Booster contract
/// @dev Be aware that staking entry is Convex Booster contract while withdraw/getReward entry is BaseRewardPool contract.
/// @notice Asset tokens are token0 and token1. Staking token is the LP token of token0/token1.
contract AutoCompoundCurveConvex is ReentrancyGuard, Pausable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    struct BalanceDiff {
        uint256 balBefore;
        uint256 balAfter;
        uint256 balDiff;
    }

    /* ========== STATE VARIABLES ========== */

    string public name;
    uint256 public pid; // Pool ID in Convex Booster
    IConverterUniV3 public converter;
    IERC20 public lp;
    IERC20 public token0;
    IERC20 public token1;
    IERC20 public crv;
    IERC20 public cvx;
    IERC20 public BCNT;

    IDepositCompound public curveDepositCompound;
    IConvexBooster public convexBooster;
    IConvexBaseRewardPool public convexBaseRewardPool;

    /// @dev Piggyback on BaseRewardPool' reward accounting
    mapping(address => uint256) internal _userRewardPerTokenPaid;
    mapping(address => uint256) internal _rewards;

    uint256 internal _totalSupply;
    mapping(address => uint256) internal _balances;

    uint256 public lpAmountCompounded;
    address public operator;

    bytes public cvxUniV3SwapPath; // e.g., CVX -> WETH -> token0
    bytes public bcntUniV3SwapPath; // e.g., token0 -> WETH -> CVX

    /* ========== FALLBACKS ========== */

    receive() external payable {}

    /* ========== CONSTRUCTOR ========== */

    function initialize(
        string memory _name,
        uint256 _pid,
        address _owner,
        address _operator,
        IConverterUniV3 _converter,
        address _curveDepositCompound,
        address _convexBooster,
        address _convexBaseRewardPool,
        address _BCNT
    ) external {
        require(keccak256(abi.encodePacked(name)) == keccak256(abi.encodePacked("")), "Already initialized");
        super.initializePausable(_owner);
        super.initializeReentrancyGuard();

        name = _name;
        pid = _pid;
        operator = _operator;
        converter = _converter;
        curveDepositCompound = IDepositCompound(_curveDepositCompound);
        lp = IERC20(curveDepositCompound.token());
        token0 = IERC20(curveDepositCompound.underlying_coins(0));
        token1 = IERC20(curveDepositCompound.underlying_coins(1));
        convexBooster = IConvexBooster(_convexBooster);
        convexBaseRewardPool = IConvexBaseRewardPool(_convexBaseRewardPool);
        crv = IERC20(convexBaseRewardPool.rewardToken());
        require(address(convexBooster.crv()) == address(crv));
        cvx = IERC20(convexBooster.minter());
        BCNT = IERC20(_BCNT);
    }

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

    /// @notice Get the reward share earned by specified account.
    function _share(address account) public view returns (uint256) {
        uint256 rewardPerToken = convexBaseRewardPool.rewardPerToken();
        return (_balances[account] * (rewardPerToken - _userRewardPerTokenPaid[account]) / (1e18)) + _rewards[account];
    }

    /// @notice Get the total reward share in this contract.
    /// @notice Total reward is tracked with `_rewards[address(this)]` and `_userRewardPerTokenPaid[address(this)]`
    function _shareTotal() public view returns (uint256) {
        uint256 rewardPerToken = convexBaseRewardPool.rewardPerToken();
        return (_totalSupply * (rewardPerToken - _userRewardPerTokenPaid[address(this)]) / (1e18)) + _rewards[address(this)];
    }

    /// @notice Get the compounded LP amount earned by specified account.
    function earned(address account) public view returns (uint256) {
        uint256 rewardsShare;
        if (account == address(this)){
            rewardsShare = _shareTotal();
        } else {
            rewardsShare = _share(account);
        }

        uint256 earnedCompoundedLPAmount;
        if (rewardsShare > 0) {
            uint256 totalShare = _shareTotal();
            // Earned compounded LP amount is proportional to how many rewards this account has
            // among total rewards
            earnedCompoundedLPAmount = lpAmountCompounded * rewardsShare / totalShare;
        }
        return earnedCompoundedLPAmount;
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    function _convertAndAddLiquidity(
        bool isToken0,
        bool shouldTransferFromSender, 
        uint256 amount,
        uint256 minLiqAddedAmount
    ) internal returns (uint256 lpAmount) {
        require(amount > 0, "Cannot stake 0");
        uint256 lpAmountBefore = lp.balanceOf(address(this));
        uint256 token0AmountBefore = token0.balanceOf(address(this));
        uint256 token1AmountBefore = token1.balanceOf(address(this));

        // Add liquidity
        uint256[2] memory uamounts;
        if (isToken0) {
            if (shouldTransferFromSender) {
                token0.safeTransferFrom(msg.sender, address(this), amount);
            }
            uamounts[0] = amount;
            uamounts[1] = 0;
            token0.safeApprove(address(curveDepositCompound), amount);
            curveDepositCompound.add_liquidity(uamounts, minLiqAddedAmount);
        } else {
            if (shouldTransferFromSender) {
                token1.safeTransferFrom(msg.sender, address(this), amount);
            }
            uamounts[0] = 0;
            uamounts[1] = amount;
            token1.safeApprove(address(curveDepositCompound), amount);
            curveDepositCompound.add_liquidity(uamounts, minLiqAddedAmount);
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

    /// @dev Be aware that staking entry is Convex Booster contract while withdraw/getReward entry is BaseRewardPool contract.
    /// This is because staking token for BaseRewardPool is the deposit token that can only minted by Booster.
    /// Booster.deposit() will do some processing and stake into BaseRewardPool for us.
    function _stake(address staker, uint256 lpAmount) internal {
        lp.safeApprove(address(convexBooster), lpAmount);
        convexBooster.deposit(
            pid,
            lpAmount,
            true // True indicate to also stake into BaseRewardPool
        );
        _totalSupply = _totalSupply + lpAmount;
        _balances[staker] = _balances[staker] + lpAmount;
        emit Staked(staker, lpAmount);
    }

    /// @notice Taken token0 or token1 in, provide liquidity in Curve and stake
    /// the LP token into Convex contract. Leftover token0 or token1 will be returned to msg.sender.
    /// @param isToken0 Determine if token0 is the token msg.sender going to use for staking, token1 otherwise
    /// @param amount Amount of token0 or token1 to stake
    /// @param minLiqAddedAmount The minimum amount of LP token received when adding liquidity
    function stake(
        bool isToken0,
        uint256 amount,
        uint256 minLiqAddedAmount
    ) public nonReentrant notPaused updateReward(msg.sender) {
        uint256 lpAmount = _convertAndAddLiquidity(isToken0, true, amount, minLiqAddedAmount);
        _stake(msg.sender, lpAmount);
    }

    /// @notice Take LP tokens and stake into Convex contract.
    /// @param lpAmount Amount of LP tokens to stake
    function stakeWithLP(uint256 lpAmount) public nonReentrant notPaused updateReward(msg.sender) {
        lp.safeTransferFrom(msg.sender, address(this), lpAmount);
        _stake(msg.sender, lpAmount);
    }

    function _removeLP(IERC20 token, bool toToken0, uint256 amount, uint256 minAmountReceived) internal returns (uint256) {
        uint256 balBefore = token.balanceOf(address(this));

        lp.safeApprove(address(curveDepositCompound), amount);
        curveDepositCompound.remove_liquidity_one_coin(
            amount,
            toToken0 ? int128(0) : int128(1),
            minAmountReceived,
            true // Donate dust
        );
        uint256 balAfter = token.balanceOf(address(this));
        return balAfter - balBefore;
    }

    /// @notice Withdraw stake from BaseRewardPool, remove liquidity and convert one asset to another.
    /// @param toToken0 Determine to convert all to token0 or token 1
    /// @param minAmountReceived The minimum amount of token0 or token1 received when removing liquidity
    /// @param amount Amount of stake to withdraw
    function withdraw(
        bool toToken0,
        uint256 minAmountReceived,
        uint256 amount
    ) public nonReentrant updateReward(msg.sender) {
        require(amount > 0, "Cannot withdraw 0");

        // Update records:
        // substract withdrawing LP amount from total LP amount staked
        _totalSupply = (_totalSupply - amount);
        // substract withdrawing LP amount from user's balance
        _balances[msg.sender] = (_balances[msg.sender] - amount);

        // Withdraw and unwrap to LP token
        convexBaseRewardPool.withdrawAndUnwrap(
            amount,
            false // No need to getReward when withdraw
        );

        IERC20 token = toToken0 ? token0 : token1;
        uint256 receivedTokenAmount = _removeLP(token, toToken0, amount, minAmountReceived);
        token.safeTransfer(msg.sender, receivedTokenAmount);

        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Withdraw LP tokens from BaseRewardPool contract and return to user.
    /// @param lpAmount Amount of LP tokens to withdraw
    function withdrawWithLP(uint256 lpAmount) public nonReentrant notPaused updateReward(msg.sender) {
        require(lpAmount > 0, "Cannot withdraw 0");

        // Update records:
        // substract withdrawing LP amount from total LP amount staked
        _totalSupply = (_totalSupply - lpAmount);
        // substract withdrawing LP amount from user's balance
        _balances[msg.sender] = (_balances[msg.sender] - lpAmount);

        // Withdraw and unwrap to LP token
        convexBaseRewardPool.withdrawAndUnwrap(
            lpAmount,
            false // No need to getReward when withdraw
        );
        lp.safeTransfer(msg.sender, lpAmount);

        emit Withdrawn(msg.sender, lpAmount);
    }

    /// @notice Get the reward out and convert one asset to another. Note that reward is LP token.
    /// @param minAmountToken0Received The minimum amount of token0 received when removing liquidity
    /// @param minAmountBCNTReceived The minimum amount of BCNT received when converting token0 to BCNT
    function getReward(
        uint256 minAmountToken0Received,
        uint256 minAmountBCNTReceived
    ) public updateReward(msg.sender)  {        
        uint256 reward = _rewards[msg.sender];
        uint256 totalReward = _rewards[address(this)];
        if (reward > 0) {
            // compoundedLPRewardAmount: based on user's reward and totalReward,
            // determine how many compouned(read: extra) LP amount can user take away.
            // NOTE: totalReward = _rewards[address(this)];
            uint256 compoundedLPRewardAmount = lpAmountCompounded * reward / totalReward;

            // Update records:
            // substract user's rewards from totalReward
            _rewards[msg.sender] = 0;
            _rewards[address(this)] = (totalReward - reward);
            // substract compoundedLPRewardAmount from lpAmountCompounded
            lpAmountCompounded = (lpAmountCompounded - compoundedLPRewardAmount);

            // Withdraw compounded LP and unwrap
            convexBaseRewardPool.withdrawAndUnwrap(
                compoundedLPRewardAmount,
                false // No need to getReward when withdraw
            );

            // Remove LP and convert to token0
            uint256 receivedToken0Amount = _removeLP(token0, true, compoundedLPRewardAmount, minAmountToken0Received);
            // Convert token0 to BCNT via UniswapV3 pool
            token0.approve(address(converter), receivedToken0Amount);
            converter.convertUniV3(address(token0), receivedToken0Amount, 100, address(BCNT), minAmountBCNTReceived, msg.sender, bcntUniV3SwapPath);

            emit RewardPaid(msg.sender, compoundedLPRewardAmount);
        }
    }

    /// @notice Withdraw all stake from BaseRewardPool, remove liquidity, get the reward out and convert one asset to another.
    /// @param toToken0 Determine to convert all to token0 or token 1
    /// @param minAmountReceived The minimum amount of token0 or token1 received when removing liquidity
    function exit(bool toToken0, uint256 minAmountReceived, uint256 minAmountBCNTReceived) external {
        withdraw(toToken0, minAmountReceived, _balances[msg.sender]);
        getReward(minAmountReceived, minAmountBCNTReceived);
    }

    /// @notice Withdraw all stake from BaseRewardPool, get the reward out and convert one asset to another.
    /// @param minAmountReceived The minimum amount of token0 or token1 received when removing liquidity
    function exitWithLP(uint256 minAmountReceived, uint256 minAmountBCNTReceived) external {
        withdrawWithLP(_balances[msg.sender]);
        getReward(minAmountReceived, minAmountBCNTReceived);
    }

    /* ========== RESTRICTED FUNCTIONS ========== */

    /// @notice Get all reward out from BaseRewardPool contract, convert rewards to token0 and token1, provide liquidity and stake
    /// the LP tokens back into BaseRewardPool contract.
    /// @dev LP tokens staked this way will be tracked in `lpAmountCompounded`.
    /// @param minCrvToToken0Swap The minimum amount of token0 received when swapping CRV to token0
    /// @param minCvxToToken0Swap The minimum amount of token0 received when swapping CVX to token0
    /// @param minLiqAddedAmount The minimum amount of LP token received when adding liquidity
    function compound(
        uint256 minCrvToToken0Swap,
        uint256 minCvxToToken0Swap,
        uint256 minLiqAddedAmount
    ) external nonReentrant updateReward(address(0)) onlyOperator {
        // getReward will get us CRV and CVX
        convexBaseRewardPool.getReward(address(this), true);

        BalanceDiff memory lpAmountDiff;
        lpAmountDiff.balBefore = lp.balanceOf(address(this));
        BalanceDiff memory token0Diff;
        token0Diff.balBefore = token0.balanceOf(address(this));

        // Try convert CRV to token0
        uint256 crvBalance = crv.balanceOf(address(this));
        if (crvBalance > 0) {
            crv.approve(address(converter), crvBalance);
            try converter.convert(address(crv), crvBalance, 100, address(token0), minCrvToToken0Swap, address(this)) {

            } catch Error(string memory reason) {
                emit ConvertFailed(address(crv), address(token0), crvBalance, reason, bytes(""));
            } catch (bytes memory lowLevelData) {
                emit ConvertFailed(address(crv), address(token0), crvBalance, "", lowLevelData);
            }
        }
        // Try convert CVX to token0
        uint256 cvxBalance = cvx.balanceOf(address(this));
        if (cvxBalance > 0) {
            // Use UniV3 for CVX since CVX does not have enough liquidity in UniV2
            cvx.approve(address(converter), cvxBalance);
            try converter.convertUniV3(address(cvx), cvxBalance, 100, address(token0), minCvxToToken0Swap, address(this), cvxUniV3SwapPath) {

            } catch Error(string memory reason) {
                emit ConvertFailed(address(cvx), address(token0), cvxBalance, reason, bytes(""));
            } catch (bytes memory lowLevelData) {
                emit ConvertFailed(address(cvx), address(token0), cvxBalance, "", lowLevelData);
            }
        }
        token0Diff.balAfter = token0.balanceOf(address(this));
        token0Diff.balDiff = (token0Diff.balAfter - token0Diff.balBefore);

        // Add liquidity if there are token0 converted
        if (token0Diff.balDiff > 0) {
            uint256[2] memory uamounts;
            uamounts[0] = token0Diff.balDiff;
            uamounts[1] = 0;
            token0.safeApprove(address(curveDepositCompound), token0Diff.balDiff);
            curveDepositCompound.add_liquidity(uamounts, minLiqAddedAmount);
            lpAmountDiff.balAfter = lp.balanceOf(address(this));
            lpAmountDiff.balDiff = (lpAmountDiff.balAfter - lpAmountDiff.balBefore);
            // Add compounded LP tokens to lpAmountCompounded
            lpAmountCompounded = lpAmountCompounded + lpAmountDiff.balDiff;

            // Stake the compounded LP tokens back in
            lp.safeApprove(address(convexBooster), lpAmountDiff.balDiff);
            convexBooster.deposit(
                pid,
                lpAmountDiff.balDiff,
                true // True indicate to also stake into BaseRewardPool
            );
            emit Compounded(lpAmountDiff.balDiff);
        }
    }

    function recoverERC20(address tokenAddress, uint256 tokenAmount) external onlyOwner {
        require(tokenAddress != address(lp), "Cannot withdraw the staking token");
        IERC20(tokenAddress).safeTransfer(owner, tokenAmount);
        emit Recovered(tokenAddress, tokenAmount);
    }

    function updateCVXUniV3SwapPath(bytes calldata newPath) external onlyOperator {
        cvxUniV3SwapPath = newPath;

        emit UpdateCVXUniV3SwapPath(newPath);
    }

    function updateBCNTUniV3SwapPath(bytes calldata newPath) external onlyOperator {
        bcntUniV3SwapPath = newPath;

        emit UpdateBCNTUniV3SwapPath(newPath);
    }

    function updateOperator(address newOperator) external onlyOwner {
        operator = newOperator;

        emit UpdateOperator(newOperator);
    }

    function _authorizeUpgrade(address newImplementation) internal view override onlyOwner {}

    /* ========== MODIFIERS ========== */

    modifier updateReward(address account) {
        uint256 rewardPerTokenStored = convexBaseRewardPool.rewardPerToken();
        if (account != address(0)) {
            _rewards[account] = _share(account);
            _userRewardPerTokenPaid[account] = rewardPerTokenStored;

            // Use _rewards[address(this)] to keep track of rewards earned by all accounts.
            // NOTE: it does not count into the compounded reward because compouned reward
            // are continuosly converted to LP tokens and user will be rewarded with
            // compounded LP tokens instead of compounded rewards.
            _rewards[address(this)] = _shareTotal();
            _userRewardPerTokenPaid[address(this)] = rewardPerTokenStored;
        }
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "Only the contract operator may perform this action");
        _;
    }

    /* ========== EVENTS ========== */

    event UpdateCVXUniV3SwapPath(bytes newPath);
    event UpdateBCNTUniV3SwapPath(bytes newPath);
    event UpdateOperator(address newOperator);
    event Staked(address indexed user, uint256 amount);
    event ConvertFailed(address fromToken, address toToken, uint256 fromAmount, string reason, bytes lowLevelData);
    event Compounded(uint256 lpAmount);
    event RewardPaid(address indexed user, uint256 rewardLPAmount);
    event Withdrawn(address indexed user, uint256 amount);
    event Recovered(address token, uint256 amount);
}