import { NodeConnectionTypes, type INodeType, type INodeTypeDescription } from 'n8n-workflow';

export class AirProcess implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'AirProcess',
		name: 'airProcess',
		icon: { light: 'file:../../icons/airprocess.svg', dark: 'file:../../icons/airprocess.dark.svg' },
		group: ['input'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["modelId"]}}',
		description: 'Create and fetch records from AirProcess',
		defaults: {
			name: 'AirProcess',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'httpBearerAuth',
				required: true,
			},
		],
		requestDefaults: {
			baseURL: 'https://app.airprocess.com',
			headers: {
				Accept: 'application/json',
			},
		},
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Record',
						value: 'record',
					},
				],
				default: 'record',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['record'],
					},
				},
				options: [
					{
						name: 'Get',
						value: 'get',
						action: 'Get a record',
						routing: {
							request: {
								method: 'GET',
								url: '=/{{$parameter.modelId}}/{{$parameter.recordId}}',
							},
						},
					},
					{
						name: 'Get Many',
						value: 'getAll',
						action: 'Get all records',
						routing: {
							request: {
								method: 'GET',
								url: '=/{{$parameter.modelId}}',
							},
						},
					},
					{
						name: 'Create',
						value: 'create',
						action: 'Create a record',
						routing: {
							request: {
								method: 'POST',
								url: '=/{{$parameter.modelId}}',
								body: '={{$parameter.body}}',
								headers: {
									'Content-Type': 'application/json',
								},
							},
						},
					},
				],
				default: 'getAll',
			},
			{
				displayName: 'Model ID',
				name: 'modelId',
				type: 'string',
				required: true,
				default: '',
				description: 'Model identifier used in the path',
			},
			{
				displayName: 'Record ID',
				name: 'recordId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						resource: ['record'],
						operation: ['get'],
					},
				},
				description: 'Record identifier used in the path',
			},
			{
				displayName: 'Body',
				name: 'body',
				type: 'json',
				required: true,
				default: '{\n  "kdx42bqx": "Bob wilson",\n  "id": "34be8047-4652-4685-808d-85df6a80ddb7"\n}',
				displayOptions: {
					show: {
						resource: ['record'],
						operation: ['create'],
					},
				},
				description: 'JSON body sent to AirProcess',
			},
		],
	};
}
