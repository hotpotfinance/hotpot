pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./BaseSingleTokenStakingCakeFarm.sol";

/// @title A contract for temporarily managin stake for users. 
/// @notice When main contract calls `stake`, it receives LP token from main contract and stake it.
/// When main contract calls `exit`, it withdraws stake, get reward and convert reward to LP token
/// and transfer LP token to main contract.
contract TempStakeManagerCakeFarm is BaseSingleTokenStakingCakeFarm {
    using EnumerableSet for EnumerableSet.AddressSet;
    using SafeERC20 for IERC20;

    struct BalanceDiff {
        uint256 balBefore;
        uint256 balAfter;
        uint256 balDiff;
    }

    struct ExitRelatedVars {
        uint256 lpAmount;
        uint256 reward;
        IERC20 rewardToken;
    }

    struct minAmountVars {
        uint256 rewardToToken0Swap;
        uint256 tokenInToTokenOutSwap;
        uint256 tokenInAddLiq;
        uint256 tokenOutAddLiq;
    }

    /* ========== STATE VARIABLES ========== */

    address public mainContract;
    EnumerableSet.AddressSet private _stakerList;

    /* ========== CONSTRUCTOR ========== */

    function initialize(
        string memory _name,
        address _owner,
        address _BCNT,
        IERC20 _cake,
        uint256 _pid,
        IConverter _converter,
        IMasterChef _masterChef,
        address _mainContract
    ) external {
        require(keccak256(abi.encodePacked(name)) == keccak256(abi.encodePacked("")), "Already initialized");
        super.initializePausable(_owner);
        super.initializeReentrancyGuard();

        name = _name;
        BCNT = _BCNT;
        cake = _cake;
        pid = _pid;
        converter = _converter;
        masterChef = _masterChef;

        (address _poolLP, , ,) = masterChef.poolInfo(_pid);
        lp = IERC20(_poolLP);
        token0 = IERC20(IPancakePair(_poolLP).token0());
        token1 = IERC20(IPancakePair(_poolLP).token1());

        mainContract = _mainContract;
    }

    /* ========== VIEWS ========== */

    function getStakerAt(uint256 index) public view returns (address) {
        return _stakerList.at(index);
    }

    function getStakersUpto(uint256 index) public view returns (address[] memory) {
        address[] memory stakerList = new address[](index);
        for (uint256 i = 0; i < index; i++) {
            stakerList[i] = (_stakerList.at(i));
        }
        return stakerList;
    }

    function getAllStakers() public view returns (address[] memory) {
        uint256 numStaker = _stakerList.length();
        address[] memory stakerList = new address[](numStaker);
        for (uint256 i = 0; i < numStaker; i++) {
            stakerList[i] = (_stakerList.at(i));
        }
        return stakerList;
    }

    /// @dev Get the reward earned by specified account
    function earned(address account) public override view returns (uint256) {
        UserInfo memory user = userInfo[account];

        uint256 totalAllocPoint = masterChef.totalAllocPoint();
        uint256 cakePerBlock = masterChef.cakePerBlock();
        (, uint256 allocPoint, uint256 lastRewardBlock, uint256 accCakePerShare) = masterChef.poolInfo(pid);
        uint256 lpSupply = lp.balanceOf(address(masterChef));
        if (block.number > lastRewardBlock && lpSupply != 0) {
            uint256 multiplier = masterChef.getMultiplier(lastRewardBlock, block.number);
            uint256 cakeReward = (multiplier * cakePerBlock * allocPoint) / totalAllocPoint;
            accCakePerShare = accCakePerShare + ((cakeReward * 1e12) / lpSupply);
        }
        return user.amount * accCakePerShare / 1e12 - user.rewardDebt + user.accruedReward;
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    /// @notice Override and intentionally failing the normal stake function
    function stake(
        bool isToken0,
        uint256 amount,
        uint256 minReceivedTokenAmountSwap,
        uint256 minToken0AmountAddLiq,
        uint256 minToken1AmountAddLiq
    ) public override {
        revert("This function is not available");
    }

    /// @notice Receive LP tokens from main contract and stake it.
    /// @param staker Account that is staking
    /// @param lpAmount Amount of lp token staker staked and transfer to this contract
    function stake(address staker, uint256 lpAmount) public onlyMainContract nonReentrant notPaused updateReward(staker) {
        _stake(staker, lpAmount);

        _stakerList.add(staker);

        emit Staked(staker, lpAmount);
    }

    /// @notice Override and intentionally failing the normal withdraw function
    function withdraw(uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 token0Percentage, uint256 amount) public override {
        revert("This function is not available");
    }

    /// @notice Override and intentionally failing the normal getReward function
    function getReward(uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 minBCNTAmountConverted) public override {
        revert("This function is not available");
    }

    /// @notice Override and intentionally failing the inherited exit function
    function exit(uint256 minToken0AmountConverted, uint256 minToken1AmountConverted, uint256 minBCNTAmountConverted, uint256 token0Percentage) public override {
        revert("This function is not available");
    }

    /// @notice Withdraw stake from MasterChef, get the reward out and convert reward to LP token
    /// and transfer LP token to main contract.
    /// @param staker Account that is staking
    /// @param minAmounts The minimum amounts of
    /// 1. token0 expected to receive when swapping reward token for token0
    /// 2. tokenOut expected to receive when swapping inToken for outToken
    /// 3. tokenIn expected to add when adding liquidity
    /// 4. tokenOut expected to add when adding liquidity
    /// @return lpAmount Amount of LP token withdrawn
    /// @return convertedLPAmount Amount of LP token converted from reward
    function exit(address staker, minAmountVars memory minAmounts) external onlyMainContract nonReentrant updateReward(staker) returns (uint256, uint256) {
        ExitRelatedVars memory exitVars;
        exitVars.lpAmount = userInfo[staker].amount;
        exitVars.reward = userInfo[staker].accruedReward;

        // Clean up staker's balance
        userInfo[address(this)].amount = userInfo[address(this)].amount - exitVars.lpAmount;
        userInfo[staker].amount = 0;
        // Withdraw stake
        masterChef.withdraw(pid, exitVars.lpAmount);

        // Get reward and convert to LP token
        BalanceDiff memory lpAmountDiff;
        if (exitVars.reward > 0) {
            userInfo[staker].accruedReward = 0;

            exitVars.rewardToken = cake;
            lpAmountDiff.balBefore = lp.balanceOf(address(this));

            BalanceDiff memory token0Diff;
            token0Diff.balBefore = token0.balanceOf(address(this));
            // Convert rewards to token0
            exitVars.rewardToken.safeApprove(address(converter), exitVars.reward);
            converter.convert(address(exitVars.rewardToken), exitVars.reward, 100, address(token0), minAmounts.rewardToToken0Swap, address(this));
            token0Diff.balAfter = token0.balanceOf(address(this));
            token0Diff.balDiff = (token0Diff.balAfter - token0Diff.balBefore);

            // Convert converted token0 to LP tokens
            token0.safeApprove(address(converter), token0Diff.balDiff);
            converter.convertAndAddLiquidity(
                address(token0),
                token0Diff.balDiff,
                address(token1),
                minAmounts.tokenInToTokenOutSwap,
                minAmounts.tokenInAddLiq,
                minAmounts.tokenOutAddLiq,
                address(this)
            );

            lpAmountDiff.balAfter = lp.balanceOf(address(this));
            lpAmountDiff.balDiff = (lpAmountDiff.balAfter - lpAmountDiff.balBefore);
            emit ConvertedLP(staker, lpAmountDiff.balDiff);
        }

        _stakerList.remove(staker);

        // Transfer withdrawn LP amount plus converted LP amount
        lp.transfer(mainContract, exitVars.lpAmount + lpAmountDiff.balDiff);
        emit Withdrawn(staker, exitVars.lpAmount);

        return (exitVars.lpAmount, lpAmountDiff.balDiff);
    }

    function _convertCakeToBCNTAndTransfer(address receiver, uint256 amount, uint256 minBCNTAmountConverted) internal {
        // Convert Cake to BCNT
        cake.safeApprove(address(converter), amount);
        converter.convert(address(cake), amount, 100, BCNT, minBCNTAmountConverted, receiver);
    }

    /// @notice Withdraw stake from MasterChef, get the reward out send them to staker
    /// @param staker Account that is aborting
    /// @param minBCNTAmountConverted The minimum amount of BCNT received swapping Cake for BCNT
    function abort(address staker, uint256 minBCNTAmountConverted) external onlyMainContract nonReentrant updateReward(staker) {
        uint256 lpAmount = userInfo[staker].amount;
        if (lpAmount > 0) {
            // Clean up staker's balance
            userInfo[address(this)].amount = userInfo[address(this)].amount - lpAmount;
            userInfo[staker].amount = 0;
            // Withdraw stake
            masterChef.withdraw(pid, lpAmount);
            // Transfer withdrawn LP
            lp.transfer(staker, lpAmount);
            emit Abort(staker, lpAmount);
        }

        // Get reward
        uint256 reward = userInfo[staker].accruedReward;
        if (reward > 0) {
            // Clean up staker's reward
            userInfo[staker].accruedReward = 0;
            // Transfer reward
            _convertCakeToBCNTAndTransfer(staker, reward, minBCNTAmountConverted);
            emit RewardPaid(staker, reward);
        }

        _stakerList.remove(staker);
    }

    /* ========== RESTRICTED FUNCTIONS ========== */

    function updateMainContract(address newMainContract) external onlyOwner {
        mainContract = newMainContract;
    }

    /* ========== MODIFIERS ========== */

    modifier onlyMainContract() {
        require(msg.sender == mainContract, "Only the contract operator may perform this action");
        _;
    }

    /* ========== EVENTS ========== */

    event ConvertedLP(address indexed user, uint256 rewardLPAmount);
    event Abort(address indexed user, uint256 lpAmount);
    event RewardPaid(address indexed user, uint256 rewardAmount);
}