import { ethers } from "hardhat"
import "@nomiclabs/hardhat-waffle"
import "@nomiclabs/hardhat-ethers"

import { mnemonic } from './secrets.json';

export default {
    // defaultNetwork: "hardhat",
    networks: {
        localhost: {
            url: "http://127.0.0.1:8545"
        },
        // hardhat: {
        //     chainId: 56,
        //     forking: {
        //         url: "https://bsc-dataseed.binance.org/",
        //         blockNumber: 11218160
        //     }
        // },
        testnet: {
            url: "https://data-seed-prebsc-1-s1.binance.org:8545",
            chainId: 97,
            accounts: { mnemonic: mnemonic }
        },
        mainnet: {
            url: "https://bsc-dataseed.binance.org/",
            chainId: 56,
            accounts: { mnemonic: mnemonic }
        }
    },
    solidity: {
        compilers: [
            {
                version: "0.4.18",
                settings: {
                    optimizer: {
                        enabled: false
                    }
                }
            },
            {
                version: "0.5.16",
                settings: {
                    optimizer: {
                        enabled: true
                    }
                }
            },
            {
                version: "0.6.12",
                settings: {
                    optimizer: {
                        enabled: true
                    }
                }
            },
            {
                version: "0.8.4",
                settings: {
                    optimizer: {
                        enabled: true
                    }
                }
            },
        ]
    },
    paths: {
        sources: "./contracts",
        tests: "./test",
        cache: "./cache",
        artifacts: "./artifacts"
    },
    mocha: {
        timeout: 200000
    }
}

