import {
	NodeConnectionTypes,
	type ILoadOptionsFunctions,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

type AirProcessModel = {
	id?: string;
	name?: string;
	modelID?: string;
	modelId?: string;
	ModelName?: string;
	modelName?: string;
};

type AirProcessModelField = {
	id?: string;
	label?: string;
	name?: string;
	fieldID?: string;
	fieldId?: string;
	type?: string;
	items?: AirProcessModelField[];
};

type AirProcessPanel = {
	items?: AirProcessModelField[];
};

function toModelOption(item: AirProcessModel): INodePropertyOptions | null {
	const modelId = item.modelID ?? item.modelId ?? item.id;
	const modelName = item.ModelName ?? item.modelName ?? item.name;

	if (typeof modelId !== 'string' || modelId.length === 0) {
		return null;
	}

	if (typeof modelName !== 'string' || modelName.length === 0) {
		return null;
	}

	return {
		name: modelName,
		value: modelId,
	};
}

function toFieldOption(item: AirProcessModelField): INodePropertyOptions | null {
	const fieldId = item.id ?? item.fieldID ?? item.fieldId;
	const fieldName = item.label ?? item.name ?? fieldId;

	if (typeof fieldId !== 'string' || fieldId.length === 0) {
		return null;
	}

	if (typeof fieldName !== 'string' || fieldName.length === 0) {
		return null;
	}

	return {
		name: fieldName.trim().length > 0 ? fieldName : `Field ${fieldId}`,
		value: fieldId,
	};
}

function flattenPanelFields(items: AirProcessModelField[]): AirProcessModelField[] {
	const output: AirProcessModelField[] = [];

	for (const item of items) {
		if (item?.type === 'panel' && Array.isArray(item.items)) {
			output.push(...flattenPanelFields(item.items));
			continue;
		}

		output.push(item);
	}

	return output;
}

function extractFieldsFromModelDetail(modelData: { items?: AirProcessModelField[]; panel?: AirProcessPanel | AirProcessPanel[] }): AirProcessModelField[] {
	const rootItems = Array.isArray(modelData?.items) ? modelData.items : [];
	const fieldsFromPanelItems = flattenPanelFields(rootItems).filter((item) => item?.type !== 'panel');

	const panelItems = Array.isArray(modelData?.panel)
		? modelData.panel.flatMap((panel) => (Array.isArray(panel?.items) ? flattenPanelFields(panel.items) : []))
		: Array.isArray(modelData?.panel?.items)
			? flattenPanelFields(modelData.panel.items)
			: [];

	return [...fieldsFromPanelItems, ...panelItems];
}

export class AirProcess implements INodeType {
	methods = {
		loadOptions: {
			async getModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const response = await this.helpers.httpRequestWithAuthentication.call(this, 'httpBearerAuth', {
					method: 'GET',
					url: 'https://app.airprocess.com/model',
					json: true,
				});

				const records: AirProcessModel[] = Array.isArray(response)
					? (response as AirProcessModel[])
					: ((response?.data ?? response?.models ?? response?.items ?? []) as AirProcessModel[]);

				return records
					.map(toModelOption)
					.filter((option): option is INodePropertyOptions => option !== null);
			},
			async getModelFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const modelId = this.getCurrentNodeParameter('modelIdCreate') as string;

				if (!modelId) {
					return [];
				}

				const modelsResponse = await this.helpers.httpRequestWithAuthentication.call(this, 'httpBearerAuth', {
					method: 'GET',
					url: 'https://app.airprocess.com/model',
					json: true,
				});

				const models: AirProcessModel[] = Array.isArray(modelsResponse)
					? (modelsResponse as AirProcessModel[])
					: ((modelsResponse?.data ?? modelsResponse?.models ?? modelsResponse?.items ?? []) as AirProcessModel[]);

				const matchingModel = models.find((model) => model.modelID === modelId || model.modelId === modelId || model.id === modelId);
				const resolvedModelId = matchingModel?.id ?? modelId;

				const response = await this.helpers.httpRequestWithAuthentication.call(this, 'httpBearerAuth', {
					method: 'GET',
					url: `https://app.airprocess.com/model/${resolvedModelId}`,
					json: true,
				});

				const modelData = Array.isArray(response) ? response[0] : (response?.data ?? response);
				const fields = extractFieldsFromModelDetail(
					(modelData ?? {}) as { items?: AirProcessModelField[]; panel?: AirProcessPanel | AirProcessPanel[] },
				);

				let selectedFields: Array<{ fieldId?: string }> = [];
				try {
					selectedFields = (this.getCurrentNodeParameter('createFields.field') as Array<{ fieldId?: string }>) ?? [];
				} catch {
					selectedFields = [];
				}

				const selectedFieldIds = new Set<string>(
					selectedFields
						.map((field) => field.fieldId)
						.filter((fieldId): fieldId is string => typeof fieldId === 'string' && fieldId.length > 0),
				);

				const seen = new Set<string>();
				return fields
					.map(toFieldOption)
					.filter((option): option is INodePropertyOptions => option !== null)
					.filter((option) => !selectedFieldIds.has(option.value as string))
					.filter((option) => {
						if (seen.has(option.value as string)) {
							return false;
						}
						seen.add(option.value as string);
						return true;
					});
			},
		},
	};

	description: INodeTypeDescription = {
		displayName: 'AirProcess',
		name: 'airProcess',
		icon: { light: 'file:../../icons/airprocess.svg', dark: 'file:../../icons/airprocess.dark.svg' },
		group: ['input'],
		version: 1,
		subtitle:
			'={{$parameter["routeType"] + ": " + ($parameter["modelIdGet"] || $parameter["modelIdCreate"] || $parameter["modelIdPatch"] || $parameter["modelIdDelete"] || "")}}',
		description: 'Interact with the AirProcess API grouped by HTTP method',
		defaults: {
			name: 'AirProcess',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'httpBearerAuth',
				required: false,
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
				displayName: 'Route',
				name: 'routeType',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'GET',
						value: 'get',
					},
					{
						name: 'POST',
						value: 'post',
					},
					{
						name: 'PATCH',
						value: 'patch',
					},
					{
						name: 'DELETE',
						value: 'delete',
					},
					{
						name: 'Custom',
						value: 'custom',
					},
				],
				default: 'get',
			},
			{
				displayName: 'Operation',
				name: 'getOperation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						routeType: ['get'],
					},
				},
				options: [
					{
						name: 'Get a Record',
						value: 'getRecord',
						action: 'Get a record',
						routing: {
							request: {
								method: 'GET',
								url: '=/{{$parameter.modelIdGet}}/{{$parameter.recordIdGet}}',
							},
						},
					},
					{
						name: 'Get Records',
						value: 'getRecords',
						action: 'Get all records',
						routing: {
							request: {
								method: 'GET',
								url: '=/{{$parameter.modelIdGet}}',
							},
						},
					},
					{
						name: 'Get Users',
						value: 'getUsers',
						action: 'Get users',
						routing: {
							request: {
								method: 'GET',
								url: '/account',
							},
						},
					},
					{
						name: 'Get Applications',
						value: 'getApplications',
						action: 'Get applications',
						routing: {
							request: {
								method: 'GET',
								url: '/application',
							},
						},
					},
					{
						name: 'Get Groups',
						value: 'getGroups',
						action: 'Get groups',
						routing: {
							request: {
								method: 'GET',
								url: '/group',
							},
						},
					},
					{
						name: 'Get Workspaces',
						value: 'getWorkspaces',
						action: 'Get workspaces',
						routing: {
							request: {
								method: 'GET',
								url: '/workspace',
							},
						},
					},
				],
				default: 'getRecords',
			},
			{
				displayName: 'Operation',
				name: 'postOperation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						routeType: ['post'],
					},
				},
				options: [
					{
						name: 'Create a Record',
						value: 'createRecord',
						action: 'Create a record',
						routing: {
							request: {
								method: 'POST',
								url: '=/{{$parameter.modelIdCreate}}',
								body: '={{ (() => { const generatedId = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = Math.floor(Math.random() * 16); const v = c === "x" ? r : (r & 0x3) | 0x8; return v.toString(16); }); if ($parameter.createBodyMode === "fields") { const selectedFields = ($parameter.createFields && $parameter.createFields.field) ? $parameter.createFields.field : []; const payloadFromFields = selectedFields.reduce((acc, current) => { if (current.fieldId) { acc[current.fieldId] = current.value; } return acc; }, {}); return { ...payloadFromFields, id: generatedId }; } const payload = typeof $parameter.bodyCreate === "string" ? JSON.parse($parameter.bodyCreate) : $parameter.bodyCreate; return { ...payload, id: generatedId }; })() }}',
								headers: {
									'Content-Type': 'application/json',
								},
							},
						},
					},
					{
						name: 'Login',
						value: 'login',
						action: 'Login',
						routing: {
							request: {
								method: 'POST',
								url: '/login',
								body: '={{ { username: $parameter.username, password: $parameter.password } }}',
								headers: {
									'Content-Type': 'application/json',
								},
							},
						},
					},
				],
				default: 'createRecord',
			},
			{
				displayName: 'Operation',
				name: 'patchOperation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						routeType: ['patch'],
					},
				},
				options: [
					{
						name: 'Update a Record',
						value: 'updateRecord',
						action: 'Update a record',
						routing: {
							request: {
								method: 'PATCH',
								url: '=/{{$parameter.modelIdPatch}}/{{$parameter.recordIdPatch}}',
								body: '={{ typeof $parameter.bodyUpdate === "string" ? JSON.parse($parameter.bodyUpdate) : $parameter.bodyUpdate }}',
								headers: {
									'Content-Type': 'application/json',
								},
							},
						},
					},
				],
				default: 'updateRecord',
			},
			{
				displayName: 'Operation',
				name: 'deleteOperation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						routeType: ['delete'],
					},
				},
				options: [
					{
						name: 'Delete a Record',
						value: 'deleteRecord',
						action: 'Delete a record',
						routing: {
							request: {
								method: 'DELETE',
								url: '=/{{$parameter.modelIdDelete}}/{{$parameter.recordIdDelete}}',
							},
						},
					},
					{
						name: 'Send to Trash',
						value: 'sendToTrash',
						action: 'Send a record to trash',
						routing: {
							request: {
								method: 'DELETE',
								url: '=/{{$parameter.modelIdDelete}}/{{$parameter.recordIdDelete}}',
								body: '={{ { sendToTrash: true } }}',
								headers: {
									'Content-Type': 'application/json',
								},
							},
						},
					},
				],
				default: 'deleteRecord',
			},
			{
				displayName: 'Method',
				name: 'customOperation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						routeType: ['custom'],
					},
				},
				options: [
					{
						name: 'GET',
						value: 'customGet',
						action: 'Call a custom GET route',
						routing: {
							request: {
								method: 'GET',
								url: '={{ $parameter.customUrl.startsWith("http") ? $parameter.customUrl : ($parameter.customUrl.startsWith("/") ? $parameter.customUrl : "/" + $parameter.customUrl) }}',
								body: '={{ $parameter.customSendBody ? (typeof $parameter.customBody === "string" ? JSON.parse($parameter.customBody) : $parameter.customBody) : undefined }}',
								headers: {
									'Content-Type': 'application/json',
								},
							},
						},
					},
					{
						name: 'POST',
						value: 'customPost',
						action: 'Call a custom POST route',
						routing: {
							request: {
								method: 'POST',
								url: '={{ $parameter.customUrl.startsWith("http") ? $parameter.customUrl : ($parameter.customUrl.startsWith("/") ? $parameter.customUrl : "/" + $parameter.customUrl) }}',
								body: '={{ $parameter.customSendBody ? (typeof $parameter.customBody === "string" ? JSON.parse($parameter.customBody) : $parameter.customBody) : undefined }}',
								headers: {
									'Content-Type': 'application/json',
								},
							},
						},
					},
					{
						name: 'PATCH',
						value: 'customPatch',
						action: 'Call a custom PATCH route',
						routing: {
							request: {
								method: 'PATCH',
								url: '={{ $parameter.customUrl.startsWith("http") ? $parameter.customUrl : ($parameter.customUrl.startsWith("/") ? $parameter.customUrl : "/" + $parameter.customUrl) }}',
								body: '={{ $parameter.customSendBody ? (typeof $parameter.customBody === "string" ? JSON.parse($parameter.customBody) : $parameter.customBody) : undefined }}',
								headers: {
									'Content-Type': 'application/json',
								},
							},
						},
					},
					{
						name: 'DELETE',
						value: 'customDelete',
						action: 'Call a custom DELETE route',
						routing: {
							request: {
								method: 'DELETE',
								url: '={{ $parameter.customUrl.startsWith("http") ? $parameter.customUrl : ($parameter.customUrl.startsWith("/") ? $parameter.customUrl : "/" + $parameter.customUrl) }}',
								body: '={{ $parameter.customSendBody ? (typeof $parameter.customBody === "string" ? JSON.parse($parameter.customBody) : $parameter.customBody) : undefined }}',
								headers: {
									'Content-Type': 'application/json',
								},
							},
						},
					},
				],
				default: 'customGet',
			},
			{
				displayName: 'URL',
				name: 'customUrl',
				type: 'string',
				required: true,
				default: '',
				placeholder: '/your/custom/path',
				displayOptions: {
					show: {
						routeType: ['custom'],
						customOperation: ['customGet', 'customPost', 'customPatch', 'customDelete'],
					},
				},
				description: 'Custom route path or full URL',
			},
			{
				displayName: 'Send Body',
				name: 'customSendBody',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						routeType: ['custom'],
						customOperation: ['customGet', 'customPost', 'customPatch', 'customDelete'],
					},
				},
				description: 'Whether to include a request body',
			},
			{
				displayName: 'Body',
				name: 'customBody',
				type: 'json',
				default: '{}',
				displayOptions: {
					show: {
						routeType: ['custom'],
						customOperation: ['customGet', 'customPost', 'customPatch', 'customDelete'],
						customSendBody: [true],
					},
				},
				description: 'JSON body sent to AirProcess',
			},
			{
				displayName: 'Model',
				name: 'modelIdGet',
				type: 'options',
				required: true,
				typeOptions: {
					loadOptionsMethod: 'getModels',
				},
				default: '',
				displayOptions: {
					show: {
						routeType: ['get'],
						getOperation: ['getRecord', 'getRecords'],
					},
				},
				description: 'Select the model used in the path',
			},
			{
				displayName: 'Model',
				name: 'modelIdCreate',
				type: 'options',
				required: true,
				typeOptions: {
					loadOptionsMethod: 'getModels',
				},
				default: '',
				displayOptions: {
					show: {
						routeType: ['post'],
						postOperation: ['createRecord'],
					},
				},
				description: 'Select the model used in the path',
			},
			{
				displayName: 'Model',
				name: 'modelIdPatch',
				type: 'options',
				required: true,
				typeOptions: {
					loadOptionsMethod: 'getModels',
				},
				default: '',
				displayOptions: {
					show: {
						routeType: ['patch'],
						patchOperation: ['updateRecord'],
					},
				},
				description: 'Select the model used in the path',
			},
			{
				displayName: 'Model',
				name: 'modelIdDelete',
				type: 'options',
				required: true,
				typeOptions: {
					loadOptionsMethod: 'getModels',
				},
				default: '',
				displayOptions: {
					show: {
						routeType: ['delete'],
						deleteOperation: ['deleteRecord', 'sendToTrash'],
					},
				},
				description: 'Select the model used in the path',
			},
			{
				displayName: 'Record ID',
				name: 'recordIdGet',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						routeType: ['get'],
						getOperation: ['getRecord'],
					},
				},
				description: 'Record identifier used in the path',
			},
			{
				displayName: 'Record ID',
				name: 'recordIdPatch',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						routeType: ['patch'],
						patchOperation: ['updateRecord'],
					},
				},
				description: 'Record identifier used in the path',
			},
			{
				displayName: 'Record ID',
				name: 'recordIdDelete',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						routeType: ['delete'],
						deleteOperation: ['deleteRecord', 'sendToTrash'],
					},
				},
				description: 'Record identifier used in the path',
			},
			{
				displayName: 'Specify Body',
				name: 'createBodyMode',
				type: 'options',
				options: [
					{
						name: 'JSON',
						value: 'json',
					},
					{
						name: 'Using Fields Below',
						value: 'fields',
					},
				],
				default: 'json',
				displayOptions: {
					show: {
						routeType: ['post'],
						postOperation: ['createRecord'],
					},
				},
				description: 'Choose whether to send raw JSON or build the body from fields',
			},
			{
				displayName: 'Body',
				name: 'bodyCreate',
				type: 'json',
				required: true,
				default: '{\n  "kdx42bqx": "Bob wilson",\n  "id": "34be8047-4652-4685-808d-85df6a80ddb7"\n}',
				displayOptions: {
					show: {
						routeType: ['post'],
						postOperation: ['createRecord'],
						createBodyMode: ['json'],
					},
				},
				description: 'JSON body sent to AirProcess',
			},
			{
				displayName: 'Fields',
				name: 'createFields',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				placeholder: 'Add Field',
				default: {
					field: [],
				},
				displayOptions: {
					show: {
						routeType: ['post'],
						postOperation: ['createRecord'],
						createBodyMode: ['fields'],
					},
				},
				options: [
					{
						name: 'field',
						displayName: 'Field',
						values: [
							{
								displayName: 'Name',
								name: 'fieldId',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getModelFields',
									loadOptionsDependsOn: ['modelIdCreate', 'createFields.field'],
								},
								default: '',
								description: 'Select a model field',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
							},
						],
					},
				],
				description: 'Build the body by selecting model fields and values',
			},
			{
				displayName: 'Body',
				name: 'bodyUpdate',
				type: 'json',
				required: true,
				default: '{\n  "kdx42bqx": "Bob wilson"\n}',
				displayOptions: {
					show: {
						routeType: ['patch'],
						patchOperation: ['updateRecord'],
					},
				},
				description: 'JSON body sent to AirProcess',
			},
			{
				displayName: 'Username',
				name: 'username',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						routeType: ['post'],
						postOperation: ['login'],
					},
				},
				description: 'Username used to authenticate',
			},
			{
				displayName: 'Password',
				name: 'password',
				type: 'string',
				typeOptions: {
					password: true,
				},
				required: true,
				default: '',
				displayOptions: {
					show: {
						routeType: ['post'],
						postOperation: ['login'],
					},
				},
				description: 'Password used to authenticate',
			},
		],
	};
}
