pragma solidity >=0.5.0 <0.9.0;

interface ITempStakeManager {
    function stake(address staker, uint256 lpAmount) external;
    function exit(address staker) external returns (uint256 lpAmount, uint256 convertedLPAmount);
    function clearStakerList() external;
    function abort(address staker) external;
}