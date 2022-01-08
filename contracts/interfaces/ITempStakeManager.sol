pragma solidity >=0.5.0 <0.9.0;

interface ITempStakeManager {
    struct minAmountVars {
        uint256 rewardToToken0Swap;
        uint256 tokenInToTokenOutSwap;
        uint256 tokenInAddLiq;
        uint256 tokenOutAddLiq;
    }

    function getStakerAt(uint256 index) external view returns (address);
    function stake(address staker, uint256 lpAmount) external;
    function exit(address staker, minAmountVars memory minAmounts) external returns (uint256 lpAmount, uint256 convertedLPAmount);
    function abort(address staker) external;
}