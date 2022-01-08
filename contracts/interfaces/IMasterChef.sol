pragma solidity >=0.5.0 <0.9.0;

interface IMasterChef {
    // Views

    function getMultiplier(uint256 _from, uint256 _to) external view returns (uint256);

    function poolLength() external view returns (uint256);

    function pendingCake(uint256 _pid, address _user) external view returns (uint256);

    function userInfo(uint256 _pid, address _user) external view returns (uint256, uint256);

    function poolInfo(uint256 _pid) external view returns (address, uint256, uint256, uint256);

    function cakePerBlock() external view returns (uint256);

    function totalAllocPoint() external view returns (uint256);

    // Mutative

    function updatePool(uint256 _pid) external;

    function add(uint256 _allocPoint, address _lpToken, bool _withUpdate) external;

    function deposit(uint256 _pid, uint256 _amount) external;

    function withdraw(uint256 _pid, uint256 _amount) external;
}