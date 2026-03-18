import {
	NodeConnectionTypes,
	type ILoadOptionsFunctions,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

const AIRPROCESS_BASE_URL = 'https://app.airprocess.com';
const AIRPROCESS_MODELS_URL = `${AIRPROCESS_BASE_URL}/model`;

const CREATE_RECORD_BODY_EXPRESSION =
	'={{ (() => { const generatedId = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = Math.floor(Math.random() * 16); const v = c === "x" ? r : (r & 0x3) | 0x8; return v.toString(16); }); if ($parameter.createBodyMode === "fields") { const selectedFields = ($parameter.createFields && $parameter.createFields.field) ? $parameter.createFields.field : []; const payloadFromFields = selectedFields.reduce((acc, current) => { if (current.fieldId) { acc[current.fieldId] = current.value; } return acc; }, {}); return { ...payloadFromFields, id: generatedId }; } const payload = typeof $parameter.bodyCreate === "string" ? JSON.parse($parameter.bodyCreate) : $parameter.bodyCreate; return { ...payload, id: generatedId }; })() }}';

const FIND_RECORDS_MONGO_BODY_EXPRESSION =
	'={{ (() => { const selectedFields = ($parameter.findFields && $parameter.findFields.field) ? $parameter.findFields.field : []; const filter = selectedFields.reduce((acc, current) => { if (current.fieldId) { acc[current.fieldId] = current.value; } return acc; }, {}); return { operation: "search", filterSyntax: "mongo", skip: Number($parameter.findSkip ?? 0), limit: Number($parameter.findLimit ?? 10), filter }; })() }}';

/**
 * Minimal shape returned by AirProcess for model records.
 */
type AirProcessModel = {
	id?: string;
	name?: string;
	modelID?: string;
	modelId?: string;
	ModelName?: string;
	modelName?: string;
};

/**
 * Minimal shape returned by AirProcess for model field records.
 */
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

/**
 * Converts a model payload item into an n8n options item.
 */
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

/**
 * Converts a field payload item into an n8n options item.
 */
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

/**
 * AirProcess may nest fields in "panel" containers. This function flattens those trees.
 */
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

/**
 * Extracts fields from the different model detail payload layouts used by AirProcess.
 */
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

/**
 * Extracts list-like payloads from AirProcess responses.
 */
function extractListFromResponse<T>(response: unknown): T[] {
	if (Array.isArray(response)) {
		return response as T[];
	}

	if (response && typeof response === 'object') {
		const objectResponse = response as Record<string, unknown>;
		for (const key of ['data', 'models', 'items']) {
			const value = objectResponse[key];
			if (Array.isArray(value)) {
				return value as T[];
			}
		}
	}

	return [];
}

/**
 * Extracts a single payload object from AirProcess responses.
 */
function extractSingleFromResponse<T>(response: unknown): T | undefined {
	if (Array.isArray(response)) {
		return response[0] as T | undefined;
	}

	if (response && typeof response === 'object') {
		const objectResponse = response as Record<string, unknown>;
		if (objectResponse.data && typeof objectResponse.data === 'object') {
			return objectResponse.data as T;
		}
		return response as T;
	}

	return undefined;
}

/**
 * Resolves a selected model id against `/model` response variants.
 */
function resolveModelId(models: AirProcessModel[], selectedModelId: string): string {
	const matchingModel = models.find(
		(model) => model.modelID === selectedModelId || model.modelId === selectedModelId || model.id === selectedModelId,
	);
	return matchingModel?.id ?? selectedModelId;
}

async function fetchModels(loadOptions: ILoadOptionsFunctions): Promise<AirProcessModel[]> {
	const response = await loadOptions.helpers.httpRequestWithAuthentication.call(loadOptions, 'airProcessApi', {
		method: 'GET',
		url: AIRPROCESS_MODELS_URL,
		json: true,
	});

	return extractListFromResponse<AirProcessModel>(response);
}

/**
 * Shared loader used by dynamic field dropdowns ("Create" and "Find records").
 */
async function getModelFieldOptions(
	loadOptions: ILoadOptionsFunctions,
	modelIdParameterName: 'modelIdCreate' | 'modelIdFind',
	selectedFieldsParameterName: 'createFields.field' | 'findFields.field',
): Promise<INodePropertyOptions[]> {
	const modelId = loadOptions.getCurrentNodeParameter(modelIdParameterName) as string;
	if (!modelId) {
		return [];
	}

	const models = await fetchModels(loadOptions);
	const resolvedModelId = resolveModelId(models, modelId);

	const response = await loadOptions.helpers.httpRequestWithAuthentication.call(loadOptions, 'airProcessApi', {
		method: 'GET',
		url: `${AIRPROCESS_MODELS_URL}/${resolvedModelId}`,
		json: true,
	});

	const modelData = extractSingleFromResponse<{ items?: AirProcessModelField[]; panel?: AirProcessPanel | AirProcessPanel[] }>(response);
	const fields = extractFieldsFromModelDetail(modelData ?? {});

	let selectedFields: Array<{ fieldId?: string }> = [];
	try {
		selectedFields = (loadOptions.getCurrentNodeParameter(selectedFieldsParameterName) as Array<{ fieldId?: string }>) ?? [];
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
}

export class AirProcess implements INodeType {
	methods = {
		loadOptions: {
			async getModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const records = await fetchModels(this);

				return records
					.map(toModelOption)
					.filter((option): option is INodePropertyOptions => option !== null);
			},
			async getModelFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await getModelFieldOptions(this, 'modelIdCreate', 'createFields.field');
			},
			async getModelFieldsForFind(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await getModelFieldOptions(this, 'modelIdFind', 'findFields.field');
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
			'={{$parameter["routeType"] + ": " + ($parameter["modelIdGet"] || $parameter["modelIdCreate"] || $parameter["modelIdFind"] || $parameter["modelIdPatch"] || $parameter["modelIdDelete"] || "")}}',
		description: 'Interact with the AirProcess API grouped by HTTP method',
		defaults: {
			name: 'AirProcess',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'airProcessApi',
				required: true,
			},
		],
		requestDefaults: {
			baseURL: AIRPROCESS_BASE_URL,
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
						name: 'Custom',
						value: 'custom',
					},
					{
						name: 'DELETE',
						value: 'delete',
					},
					{
						name: 'GET',
						value: 'get',
					},
					{
						name: 'PATCH',
						value: 'patch',
					},
					{
						name: 'POST',
						value: 'post',
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
						name: 'Get Models',
						value: 'getModelsRoute',
						action: 'Get models',
						routing: {
							request: {
								method: 'GET',
								url: '/model',
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
								// Build payload from JSON or from selected fields, then enforce a generated UUID.
								body: CREATE_RECORD_BODY_EXPRESSION,
								headers: {
									'Content-Type': 'application/json',
								},
							},
						},
					},
					{
						name: 'Find Records (Mongo)',
						value: 'findRecordsMongo',
						action: 'Find records with mongo syntax',
						routing: {
							request: {
								method: 'POST',
								url: '=/{{$parameter.modelIdFind}}',
								// Build a mongo search payload from selected filters and pagination values.
								body: FIND_RECORDS_MONGO_BODY_EXPRESSION,
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
				displayName: 'Model Name or ID',
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
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Model Name or ID',
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
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Model Name or ID',
				name: 'modelIdFind',
				type: 'options',
				required: true,
				typeOptions: {
					loadOptionsMethod: 'getModels',
				},
				default: '',
				displayOptions: {
					show: {
						routeType: ['post'],
						postOperation: ['findRecordsMongo'],
					},
				},
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Model Name or ID',
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
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Model Name or ID',
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
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
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
								displayName: 'Field Name or ID',
								name: 'fieldId',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getModelFields',
									loadOptionsDependsOn: ['modelIdCreate', 'createFields.field'],
								},
								default: '',
								description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
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
				displayName: 'Skip',
				name: 'findSkip',
				type: 'number',
				required: true,
				default: 0,
				displayOptions: {
					show: {
						routeType: ['post'],
						postOperation: ['findRecordsMongo'],
					},
				},
				description: 'Number of records to skip',
			},
			{
				displayName: 'Limit',
				name: 'findLimit',
				type: 'number',
				required: true,
				default: 10,
				displayOptions: {
					show: {
						routeType: ['post'],
						postOperation: ['findRecordsMongo'],
					},
				},
				description: 'Maximum number of records to return',
			},
			{
				displayName: 'Filters',
				name: 'findFields',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				placeholder: 'Add Filter',
				default: {
					field: [],
				},
				displayOptions: {
					show: {
						routeType: ['post'],
						postOperation: ['findRecordsMongo'],
					},
				},
				options: [
					{
						name: 'field',
						displayName: 'Field',
						values: [
							{
								displayName: 'Field Name or ID',
								name: 'fieldId',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getModelFieldsForFind',
									loadOptionsDependsOn: ['modelIdFind', 'findFields.field'],
								},
								default: '',
								description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
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
				description: 'Build the mongo filter by selecting model fields and values',
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
