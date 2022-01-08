import { Contract } from "ethers"

export function parseLogsByName(contract: Contract, eventName: string, logs) {
    const topic = contract.interface.getEventTopic(eventName)

    return logs
        .filter((log) => log.topics[0] == topic && contract.address == log.address)
        .map((log) => contract.interface.parseLog(log))
}