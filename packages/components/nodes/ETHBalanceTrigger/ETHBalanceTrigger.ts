import { CronJob } from 'cron';
import { ethers, utils } from "ethers";
import {
	ICronJobs,
	INode, 
    INodeData, 
    INodeParams, 
    NodeType,
} from '../../src/Interface';
import { returnNodeExecutionData } from '../../src/utils';
import EventEmitter from 'events';
import { 
	ETHNetworks, 
	networkExplorers,
} from '../../src/ChainNetwork';

class ETHBalanceTrigger extends EventEmitter implements INode {
	
	label: string;
    name: string;
    type: NodeType;
    description?: string;
    version: number;
	icon?: string;
    incoming: number;
	outgoing: number;
	networks?: INodeParams[];
    credentials?: INodeParams[];
    inputParameters?: INodeParams[];
	cronJobs: ICronJobs;

	constructor() {
		super();
		this.label = 'ETH Balance Trigger';
		this.name =  'ETHBalanceTrigger';
		this.icon = 'ethereum.png';
		this.type = 'trigger';
		this.version = 1.0;
		this.description = 'Start workflow whenever ETH balance in wallet changes';
		this.incoming = 0;
		this.outgoing = 1;
		this.cronJobs = {};
		this.networks = [
			{
				label: 'Network',
				name: 'network',
				type: 'options',
				options: [
					...ETHNetworks,
				],
				default: 'homestead',
			},
			{
				label: 'Network Provider',
				name: 'networkProvider',
				type: 'options',
				options: [
					{
						label: 'Alchemy',
						name: 'alchemy',
						description: 'Avg 1K CUs/min',
						parentGroup: 'Private Nodes'
					},
					{
						label: 'Cloudfare',
						name: 'cloudfare',
						description: 'Public Cloudfare RPC',
						parentGroup: 'Public Nodes',
						show: {
							'networks.network': ['homestead']
						}
					},
					{
						label: 'Infura',
						name: 'infura',
						description: 'Avg 20 requests/min',
						parentGroup: 'Private Nodes'
					},
					{
						label: 'Custom RPC Endpoint',
						name: 'customRPC',
						description: 'HTTP endpoint',
						parentGroup: 'Custom Nodes'
					},
					{
						label: 'Custom Websocket Endpoint',
						name: 'customWebsocket',
						description: 'WSS Endpoint',
						parentGroup: 'Custom Nodes'
					},
				],
				default: '',
			},
			{
				label: 'RPC Endpoint',
				name: 'jsonRPC',
				type: 'string',
				default: '',
				show: {
					'networks.networkProvider': ['customRPC']
				}
			},
			{
				label: 'Websocket Endpoint',
				name: 'websocketRPC',
				type: 'string',
				default: '',
				show: {
					'networks.networkProvider': ['customWebsocket']
				}
			},
			
		] as INodeParams[];
		this.credentials = [
			{
				label: 'Credential Method',
				name: 'credentialMethod',
				type: 'options',
				options: [
					{
						label: 'Alchemy API Key',
						name: 'alchemyApi',
						show: {
							'networks.networkProvider': ['alchemy']
						}
					},
					{
						label: 'Infura API Key',
						name: 'infuraApi',
						show: {
							'networks.networkProvider': ['infura']
						}
					},
				],
				default: '',
				show: {
					'networks.networkProvider': ['infura', 'alchemy']
				}
			},
		] as INodeParams[];
		this.inputParameters = [
			{
				label: 'Wallet Address',
				name: 'address',
				type: 'string',
				default: '',
			},
			{
				label: 'Trigger Condition',
				name: 'triggerCondition',
				type: 'options',
				options: [
					{
						label: 'When balance increased',
						name: 'increase',
					},
					{
						label: 'When balance decreased',
						name: 'decrease',
					},
				],
				default: 'increase'
			},
			{
				label: 'Polling Time',
				name: 'pollTime',
				type: 'options',
				options: [
					{
						label: 'Every 15 secs',
						name: '15s',
					},
					{
						label: 'Every 30 secs',
						name: '30s',
					},
					{
						label: 'Every 1 min',
						name: '1min',
					},
					{
						label: 'Every 5 min',
						name: '5min',
					}, 
					{
						label: 'Every 10 min',
						name: '10min',
					},
				],
				default: '30s',
			},
		] as INodeParams[];
	};

	async runTrigger(nodeData: INodeData): Promise<void> {

		const networksData = nodeData.networks;
		const credentials = nodeData.credentials;
		const inputParametersData = nodeData.inputParameters;

        if (networksData === undefined || inputParametersData === undefined) {
            throw new Error('Required data missing');
        }

		const networkProvider = networksData.networkProvider as string;
		const network = networksData.network as string;

		if (credentials === undefined && networkProvider !== 'customRPC'
		 && networkProvider !== 'customWebsocket' && networkProvider !== 'cloudfare') {
			throw new Error('Missing credentials');
		}

		let provider: any;

		if (networkProvider === 'alchemy') {
			provider = new ethers.providers.AlchemyProvider(network, credentials!.apiKey);

		} else if (networkProvider === 'infura') {
			provider = new ethers.providers.InfuraProvider(network, {
				projectId: credentials!.projectID,
				projectSecret: credentials!.projectSecret
			});

		} else if (networkProvider === 'cloudfare') {
			provider = new ethers.providers.CloudflareProvider();

		} else if (networkProvider === 'customRPC') {
			provider = new ethers.providers.JsonRpcProvider(networksData.jsonRPC as string);

		} else if (networkProvider === 'customWebsocket') {
			provider = new ethers.providers.WebSocketProvider(networksData.websocketRPC as string);

		}

		const emitEventKey = nodeData.emitEventKey || '';
		const address = inputParametersData.address as string || '';
		const pollTime = inputParametersData.pollTime as string || '30s';
		const triggerCondition = inputParametersData.triggerCondition as string || 'increase';
	
		const cronTimes: string[] = [];

		if (pollTime === '15s') {
			cronTimes.push(`*/15 * * * * *`);
		} else if (pollTime === '30s') {
			cronTimes.push(`*/30 * * * * *`);
		} else if (pollTime === '1min') {
			cronTimes.push(`*/1 * * * *`);
		} else if (pollTime === '5min') {
			cronTimes.push(`*/5 * * * *`);
		} else if (pollTime === '10min') {
			cronTimes.push(`*/10 * * * *`);
		}
				
		let lastBalance = await provider.getBalance(address);
	
		const executeTrigger = async() => {
			let newBalance = await provider.getBalance(address);
			if (!newBalance.eq(lastBalance)) {
				if (triggerCondition === 'increase' && (newBalance - lastBalance > 0)) {
					const balanceInEth = utils.formatEther(newBalance);
					const returnItem = {
						newBalance: `${balanceInEth} ETH`,
						lastBalance: `${utils.formatEther(lastBalance)} ETH`,
						difference: `${utils.formatEther(newBalance-lastBalance)} ETH`,
						explorerLink: `${networkExplorers[network]}/address/${address}`,
						triggerCondition: 'ETH balance increase'
					};
					lastBalance = newBalance;
					this.emit(emitEventKey, returnNodeExecutionData(returnItem));
				} else if (triggerCondition === 'decrease' && (newBalance - lastBalance < 0)) {
					const balanceInEth = utils.formatEther(newBalance);
					const returnItem = {
						newBalance: `${balanceInEth} ETH`,
						lastBalance: `${utils.formatEther(lastBalance)} ETH`,
						difference: `${utils.formatEther(newBalance-lastBalance)} ETH`,
						explorerLink: `${networkExplorers[network]}/address/${address}`,
						triggerCondition: 'ETH balance decrease'
					};
					lastBalance = newBalance;
					this.emit(emitEventKey, returnNodeExecutionData(returnItem));
				} else {
					lastBalance = newBalance;
				}
			}
		};

		// Start the cron-jobs
		if (Object.prototype.hasOwnProperty.call(this.cronJobs, emitEventKey)) {
			for (const cronTime of cronTimes) {
				// Automatically start the cron job
				this.cronJobs[emitEventKey].push(new CronJob(cronTime, executeTrigger, undefined, true));
			}
		} else {
			for (const cronTime of cronTimes) {
				// Automatically start the cron job
				this.cronJobs[emitEventKey] = [new CronJob(cronTime, executeTrigger, undefined, true)];
			}
		}
	}

	async removeTrigger(nodeData: INodeData): Promise<void> {
		const emitEventKey = nodeData.emitEventKey || '';
		
		if (Object.prototype.hasOwnProperty.call(this.cronJobs, emitEventKey)) {
			const cronJobs = this.cronJobs[emitEventKey];
			for (const cronJob of cronJobs) {
				cronJob.stop();
			}
			this.removeAllListeners(emitEventKey);
		}
	}
}

module.exports = { nodeClass: ETHBalanceTrigger }