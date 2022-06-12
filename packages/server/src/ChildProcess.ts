import { ICommonObject, INodeData } from "outerbridge-components";
import { IChildProcessMessage, IRunWorkflowMessageValue, IVariableDict, IWorkflowExecutedData } from "./Interface";
import { decryptCredentialData, getEncryptionKey, decryptCredentials } from "./utils";
import lodash from 'lodash';


interface IExploredNode {
    [key: string]: number;
}

export class ChildProcess {

    /**
     * Stop child process after 5 secs timeout
     */
    static async stopChildProcess() {
		setTimeout(() => {
			process.exit(0);
		}, 50000);
	}
    
    
    /**
     * Run the workflow using Breadth First Search Topological Sort
     * @param {IRunWorkflowMessageValue} messageValue
     * @return {Promise<void>}
     */
    async runWorkflow(messageValue: IRunWorkflowMessageValue): Promise<void> {

        process.on('SIGTERM', ChildProcess.stopChildProcess);
		process.on('SIGINT', ChildProcess.stopChildProcess);

        await sendToParentProcess('start', '_');

        // Create a Queue and add our initial node in it
        const { 
            startingNodeIds, 
            componentNodes, 
            reactFlowNodes, 
            reactFlowEdges, 
            graph,
            workflowExecutedData
        } = messageValue;
      
        const nodeQueue = [] as string[];
        const exploredNode = {} as IExploredNode;
        // In the case of infinite loop, only max 3 loops will be executed
        const maxLoop = 3;

        for (let i = 0; i < startingNodeIds.length; i+=1 ) {
            nodeQueue.push(startingNodeIds[i]);
            exploredNode[startingNodeIds[i]] = maxLoop;
        }

        while (nodeQueue.length) {

            const nodeId = nodeQueue.shift() || '';
            const ignoreNodeIds: string[] = [];

            if (!startingNodeIds.includes(nodeId)) {

                const reactFlowNode = reactFlowNodes.find((nd) => nd.id === nodeId);
                if (!reactFlowNode || reactFlowNode === undefined) continue;

                try{
                    const nodeInstanceFilePath = componentNodes[reactFlowNode.data.name].filePath;
                    const nodeModule = require(nodeInstanceFilePath);
                    const newNodeInstance = new nodeModule.nodeClass();

                    await decryptCredentials(reactFlowNode.data);

                    const reactFlowNodeData: INodeData = resolveVariables(reactFlowNode.data, workflowExecutedData);

                    const result = await newNodeInstance.run!.call(newNodeInstance, reactFlowNodeData);
                
                    // Determine which nodes to route next when it comes to ifElse
                    if (result && nodeId.includes('ifElse')) {
                        let anchorIndex = -1;
                        if (Array.isArray(result) && Object.keys(result[0].data).length === 0) {
                            anchorIndex = 0;
                        } else if (Array.isArray(result) && Object.keys(result[1].data).length === 0){
                            anchorIndex = 1;
                        } 
                        const ifElseEdge = reactFlowEdges.find((edg) => (edg.source === nodeId && edg.sourceHandle === `${nodeId}-output-${anchorIndex}`));
                        if (ifElseEdge) {
                            ignoreNodeIds.push(ifElseEdge.target);
                        }
                    }

                    const newWorkflowExecutedData = {
                        nodeId,
                        nodeLabel: reactFlowNode.data.label,
                        data: result
                    } as IWorkflowExecutedData;

                    workflowExecutedData.push(newWorkflowExecutedData);
                }
                catch (e: any){
                    // console.error(e);
                    console.error(e.message);
                    const newWorkflowExecutedData = {
                        nodeId,
                        nodeLabel: reactFlowNode.data.label,
                        data: [{error: e.message}]
                    } as IWorkflowExecutedData;
                    workflowExecutedData.push(newWorkflowExecutedData);
                    console.error('CHILDPROCESS error: ', workflowExecutedData);
                    await sendToParentProcess('error', workflowExecutedData);
                    return;
                }
            }

            const neighbourNodeIds = graph[nodeId];

            for (let i = 0; i < neighbourNodeIds.length; i+=1 ) {

                const neighNodeId = neighbourNodeIds[i];

                if (!ignoreNodeIds.includes(neighNodeId)) {
                    // If nodeId has been seen, cycle detected
                    if (Object.prototype.hasOwnProperty.call(exploredNode, neighNodeId)) {
                        let remainingLoop = exploredNode[neighNodeId];
                        if (remainingLoop === 0) {
                            break;
                        } 
                        remainingLoop -= 1;
                        exploredNode[neighNodeId] = remainingLoop;
                        nodeQueue.push(neighNodeId);
                        
                    } else {
                        exploredNode[neighNodeId] = maxLoop;
                        nodeQueue.push(neighNodeId);
                    }
                }
            }
        };
        await sendToParentProcess('finish', workflowExecutedData);
    }
}


/**
 * Get variable value from outputResponses.output
 * @param {string} paramValue 
 * @param {IWorkflowExecutedData[]} workflowExecutedData
 * @returns {string}
 */
function getVariableValue(paramValue: string, workflowExecutedData: IWorkflowExecutedData[]): string {
    let returnVal = paramValue;
    const variableStack = [];
    const variableDict = {} as IVariableDict;
    let startIdx = 0;
    let endIdx = returnVal.length - 1;

    while (startIdx < endIdx) {
        const substr = returnVal.substring(startIdx, startIdx+2);
        // If this is the first opening double curly bracket
        if (substr === '{{' && variableStack.length === 0) {
            variableStack.push({ substr, startIdx: startIdx+2 });
        } else if (substr === '{{' && variableStack.length > 0 && variableStack[variableStack.length-1].substr === '{{') {
            // If we have seen opening double curly bracket without closing, replace it
            variableStack.pop();
            variableStack.push({ substr, startIdx: startIdx+2 });
        }

        // Found the complete variable
        if (substr === '}}' && variableStack.length > 0 && variableStack[variableStack.length-1].substr === '{{') {
            const variableStartIdx = variableStack[variableStack.length-1].startIdx;
            const variableEndIdx = startIdx;
            const variableFullPath = returnVal.substring(variableStartIdx, variableEndIdx);

            // Split by first occurence of '[' to get just nodeId 
            const [variableNodeId, ...rest] = variableFullPath.split('[');
            const variablePath = 'data' + '[' + rest.join('[');

            const executedNode = workflowExecutedData.find((exec) => exec.nodeId === variableNodeId);
            if (executedNode) {
                const variableValue = lodash.get(executedNode, variablePath, '');
                variableDict[`{{${variableFullPath}}}`] = variableValue;
            }
            variableStack.pop();
        }
        startIdx += 1;
    }

    for (const variablePath in variableDict) {
        const variableValue = variableDict[variablePath];

        // Replace all occurence
        returnVal = returnVal.split(variablePath).join(variableValue);
    }

    return returnVal;
}


/**
 * Loop through each inputs and resolve variable if neccessary
 * @param {INodeData} reactFlowNodeData 
 * @param {IWorkflowExecutedData[]} workflowExecutedData
 * @returns {INodeData}
 */
function resolveVariables(reactFlowNodeData: INodeData, workflowExecutedData: IWorkflowExecutedData[]): INodeData {
    const flowNodeData = lodash.cloneDeep(reactFlowNodeData);
    const types = ['actions', 'networks', 'inputParameters'];

    function getParamValues(paramsObj: ICommonObject) {
        for (const key in paramsObj) {
            const paramValue = paramsObj[key];

            if (typeof paramValue === 'string') {
                const resolvedValue = getVariableValue(paramValue, workflowExecutedData);
                paramsObj[key] = resolvedValue;
            }

            if (typeof paramValue === 'number') {
                const paramValueStr = paramValue.toString();
                const resolvedValue = getVariableValue(paramValueStr, workflowExecutedData);
                paramsObj[key] = resolvedValue;
            }

            if (Array.isArray(paramValue)) {
                for (let j = 0; j < paramValue.length; j+=1 ) {
                    getParamValues(paramValue[j] as ICommonObject);
                }
            }
        }
    }

    for (let i = 0; i < types.length; i+=1 ) {
        const paramsObj = (flowNodeData as any)[types[i]];
        getParamValues(paramsObj);
    }
    return flowNodeData;
} 

/**
 * Send data back to parent process
 * @param {string} key Key of message
 * @param {*} value Value of message
 * @returns {Promise<void>}
 */
async function sendToParentProcess(key: string, value: any): Promise<void> { // tslint:disable-line:no-any
	return new Promise((resolve, reject) => {
		process.send!({
			key,
			value,
		}, (error: Error) => {
			if (error) {
				return reject(error);
			}
			resolve();
		});
	});
}

const childProcess = new ChildProcess();

process.on('message', async (message: IChildProcessMessage) => {
    if (message.key === 'start') {
        await childProcess.runWorkflow(message.value);
        process.exit();
    }
});