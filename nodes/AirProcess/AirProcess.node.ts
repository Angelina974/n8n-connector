import {
	type IDataObject,
	type IExecuteSingleFunctions,
	type IHttpRequestOptions,
	NodeConnectionTypes,
	type ILoadOptionsFunctions,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

declare const Blob: new (
	blobParts?: Array<string | Uint8Array>,
	options?: { type?: string },
) => unknown;
declare const FormData: new () => {
	append(name: string, value: string): void;
	append(name: string, value: unknown, fileName?: string): void;
};
declare const URLSearchParams: new () => { append(name: string, value: string): void };

const AIRPROCESS_BASE_URL = 'https://app.airprocess.com';
const AIRPROCESS_MODELS_URL = `${AIRPROCESS_BASE_URL}/model`;
const CUSTOM_URL_EXPRESSION =
	'={{ $parameter.customUrl.startsWith("http") ? $parameter.customUrl : ($parameter.customUrl.startsWith("/") ? $parameter.customUrl : "/" + $parameter.customUrl) }}';
const CUSTOM_BODY_EXPRESSION =
	'={{ $parameter.customSendBody ? (typeof $parameter.customBody === "string" ? JSON.parse($parameter.customBody) : $parameter.customBody) : undefined }}';
const AUTHORIZATION_HEADER_EXPRESSION = '={{ undefined }}';
const CUSTOM_HEADERS_EXPRESSION =
	'={{ $parameter.customSendHeaders ? (typeof $parameter.customHeaders === "string" ? JSON.parse($parameter.customHeaders) : $parameter.customHeaders) : {} }}' as unknown as Record<
		string,
		string
	>;
const GET_REQUEST_OPTIONS_PARAMETER = 'getRequestOptions';
const POST_REQUEST_OPTIONS_PARAMETER = 'postRequestOptions';
const CUSTOM_REQUEST_OPTIONS_PARAMETER = 'customRequestOptions';
const RESOLVE_COLLECTION_VALUE_EXPRESSION =
	'(value) => typeof value === "string" && value.startsWith("={{") ? $evaluateExpression(value.slice(1)) : value';

/**
 * n8n expression used by "Find Records (Mongo)".
 * Builds the API body from selected filter fields and pagination options.
 */
const FIND_RECORDS_MONGO_BODY_EXPRESSION =
	`={{ (() => { const resolveCollectionValue = ${RESOLVE_COLLECTION_VALUE_EXPRESSION}; const mode = $parameter.findFilterMode ?? "fields"; const filter = mode === "json" ? (typeof $parameter.findFilterJson === "string" ? JSON.parse($parameter.findFilterJson) : ($parameter.findFilterJson ?? {})) : (($parameter.findFields && $parameter.findFields.field) ? $parameter.findFields.field : []).reduce((acc, current) => { const fieldId = resolveCollectionValue(current.fieldId); if (fieldId) { acc[fieldId] = resolveCollectionValue(current.value); } return acc; }, {}); return { operation: "search", filterSyntax: "mongo", skip: Number($parameter.findSkip ?? 0), limit: Number($parameter.findLimit ?? 10), filter }; })() }}`;

/**
 * n8n expression used by "Update a Record".
 * Supports raw JSON or selected fields.
 */
const UPDATE_RECORD_BODY_EXPRESSION =
	`={{ (() => { const resolveCollectionValue = ${RESOLVE_COLLECTION_VALUE_EXPRESSION}; if ($parameter.updateBodyMode === "fields") { const selectedFields = ($parameter.updateFields && $parameter.updateFields.field) ? $parameter.updateFields.field : []; return selectedFields.reduce((acc, current) => { const fieldId = resolveCollectionValue(current.fieldId); if (fieldId) { acc[fieldId] = resolveCollectionValue(current.value); } return acc; }, {}); } return typeof $parameter.bodyUpdate === "string" ? JSON.parse($parameter.bodyUpdate) : $parameter.bodyUpdate; })() }}`;

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

type AirProcessModelDetail = {
	items?: AirProcessModelField[];
	panel?: AirProcessPanel | AirProcessPanel[];
};

/**
 * Converts a model payload item into an n8n options item.
 *
 * @param item A raw model object returned by AirProcess.
 * @returns A dropdown option compatible with n8n, or `null` when the item is invalid.
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
 *
 * @param item A raw field object returned by AirProcess.
 * @returns A dropdown option compatible with n8n, or `null` when the item is invalid.
 */
function toFieldOption(item: AirProcessModelField): INodePropertyOptions | null {
	const fieldId = item.id ?? item.fieldID ?? item.fieldId;
	const fieldName = item.label ?? item.name ?? fieldId;
	const fieldType = typeof item.type === 'string' && item.type.length > 0 ? item.type : 'unknown';

	if (typeof fieldId !== 'string' || fieldId.length === 0) {
		return null;
	}

	if (typeof fieldName !== 'string' || fieldName.length === 0) {
		return null;
	}

	return {
		name: `${fieldName.trim().length > 0 ? fieldName : `Field ${fieldId}`} (${fieldType})`,
		value: fieldId,
	};
}

/**
 * AirProcess may nest fields in "panel" containers. This function flattens those trees.
 *
 * @param items Input list that can include nested panel containers.
 * @returns Flattened list preserving non-panel fields.
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
 *
 * @param modelData Model detail payload as returned by `/model/{id}`.
 * @returns Flat list of fields, including fields inside nested panels.
 */
function extractFieldsFromModelDetail(modelData: AirProcessModelDetail): AirProcessModelField[] {
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
 *
 * @param response Raw HTTP response payload.
 * @returns A typed list from known list keys (`data`, `models`, `items`) or an empty array.
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
 *
 * @param response Raw HTTP response payload.
 * @returns A typed object when present, otherwise `undefined`.
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

function generateUuid(): string {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
		const random = Math.floor(Math.random() * 16);
		const value = character === 'x' ? random : (random & 0x3) | 0x8;
		return value.toString(16);
	});
}

function stringifyBodyValue(value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}

	if (typeof value === 'object') {
		return JSON.stringify(value);
	}

	return String(value);
}

function getCreateFieldPayload(
	executeFunctions: IExecuteSingleFunctions,
	parameterName: 'createFields' | 'createFormFields',
): IDataObject {
	const parameterValue = executeFunctions.getNodeParameter(parameterName, {}) as {
		field?: Array<{ fieldId?: unknown; value?: unknown }>;
	};
	const selectedFields = Array.isArray(parameterValue.field) ? parameterValue.field : [];
	const payload: IDataObject = {};

	for (const current of selectedFields) {
		const fieldId =
			typeof current.fieldId === 'string'
				? current.fieldId.trim()
				: current.fieldId === undefined || current.fieldId === null
					? ''
					: String(current.fieldId).trim();

		if (fieldId.length === 0) {
			continue;
		}

		payload[fieldId] = current.value as never;
	}

	return payload;
}

function getCreateRecordJsonPayload(executeFunctions: IExecuteSingleFunctions): IDataObject {
	const bodyMode = executeFunctions.getNodeParameter('createBodyMode', 'json') as 'json' | 'fields';

	if (bodyMode === 'fields') {
		return {
			...getCreateFieldPayload(executeFunctions, 'createFields'),
			id: generateUuid(),
		};
	}

	const bodyValue = executeFunctions.getNodeParameter('bodyCreate', {}) as IDataObject | string;
	const payload =
		typeof bodyValue === 'string'
			? (JSON.parse(bodyValue) as IDataObject)
			: ((bodyValue ?? {}) as IDataObject);

	return {
		...payload,
		id: generateUuid(),
	};
}

function getCreateRecordFormPayload(executeFunctions: IExecuteSingleFunctions): IDataObject {
	return {
		...getCreateFieldPayload(executeFunctions, 'createFormFields'),
		id: generateUuid(),
	};
}

function getCustomParameterPayload(executeFunctions: IExecuteSingleFunctions): IDataObject {
	const parameterValue = executeFunctions.getNodeParameter('customFormFields', {}) as {
		parameter?: Array<{ name?: unknown; value?: unknown }>;
	};
	const parameters = Array.isArray(parameterValue.parameter) ? parameterValue.parameter : [];
	const payload: IDataObject = {};

	for (const current of parameters) {
		const name =
			typeof current.name === 'string'
				? current.name.trim()
				: current.name === undefined || current.name === null
					? ''
					: String(current.name).trim();

		if (name.length === 0) {
			continue;
		}

		payload[name] = current.value as never;
	}

	return payload;
}

function getCustomFormDataFields(executeFunctions: IExecuteSingleFunctions): Array<{
	inputDataFieldName?: string;
	name: string;
	type: 'binaryFile' | 'formData';
	value?: unknown;
}> {
	const parameterValue = executeFunctions.getNodeParameter('customFormDataFields', {}) as {
		bodyField?: Array<{
			inputDataFieldName?: unknown;
			name?: unknown;
			type?: unknown;
			value?: unknown;
		}>;
	};
	const bodyFields = Array.isArray(parameterValue.bodyField) ? parameterValue.bodyField : [];

	return bodyFields
		.map((current) => {
			const name =
				typeof current.name === 'string'
					? current.name.trim()
					: current.name === undefined || current.name === null
						? ''
						: String(current.name).trim();
			const type: 'binaryFile' | 'formData' =
				current.type === 'binaryFile' ? 'binaryFile' : 'formData';
			const inputDataFieldName =
				typeof current.inputDataFieldName === 'string'
					? current.inputDataFieldName.trim()
					: current.inputDataFieldName === undefined || current.inputDataFieldName === null
						? undefined
						: String(current.inputDataFieldName).trim();

			return {
				inputDataFieldName,
				name,
				type,
				value: current.value,
			};
		})
		.filter((field) => field.name.length > 0);
}

async function configureCreateRecordRequest(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const bodyContentType = this.getNodeParameter('createBodyContentType', 'json') as
		| 'binaryFile'
		| 'formData'
		| 'formUrlencoded'
		| 'json'
		| 'raw';
	const headers: IDataObject = {
		...(requestOptions.headers ?? {}),
	};

	switch (bodyContentType) {
		case 'binaryFile': {
			const inputDataFieldName = this.getNodeParameter('createBinaryInputDataFieldName', 'data') as string;
			const contentType = this.getNodeParameter(
				'createBinaryContentType',
				'application/octet-stream',
			) as string;
			requestOptions.body = await this.helpers.getBinaryDataBuffer(inputDataFieldName);
			headers['Content-Type'] = contentType;
			break;
		}
		case 'formData': {
			const payload = getCreateRecordFormPayload(this);
			const formData = new FormData();

			for (const [key, value] of Object.entries(payload)) {
				formData.append(key, stringifyBodyValue(value));
			}

			requestOptions.body = formData as unknown as IHttpRequestOptions['body'];
			delete headers['Content-Type'];
			break;
		}
		case 'formUrlencoded': {
			const payload = getCreateRecordFormPayload(this);
			const params = new URLSearchParams();

			for (const [key, value] of Object.entries(payload)) {
				params.append(key, stringifyBodyValue(value));
			}

			requestOptions.body = params as unknown as IHttpRequestOptions['body'];
			headers['Content-Type'] = 'application/x-www-form-urlencoded';
			break;
		}
		case 'raw': {
			const rawBody = this.getNodeParameter('createRawBody', '') as string;
			const rawContentType = this.getNodeParameter('createRawContentType', 'text/plain') as string;
			requestOptions.body = rawBody;
			headers['Content-Type'] = rawContentType;
			break;
		}
		case 'json':
		default: {
			requestOptions.body = getCreateRecordJsonPayload(this);
			headers['Content-Type'] = 'application/json';
			break;
		}
	}

	requestOptions.headers = headers;
	return requestOptions;
}

async function configureCustomTypedBodyRequest(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const sendBody = this.getNodeParameter('customSendBody', false) as boolean;

	if (!sendBody) {
		return requestOptions;
	}

	const bodyContentType = this.getNodeParameter('customBodyContentType', 'json') as
		| 'binaryFile'
		| 'formData'
		| 'formUrlencoded'
		| 'json'
		| 'raw';
	const headers: IDataObject = {
		...(requestOptions.headers ?? {}),
	};

	switch (bodyContentType) {
		case 'binaryFile': {
			const inputDataFieldName = this.getNodeParameter('customBinaryInputDataFieldName', 'data') as string;
			const contentType = this.getNodeParameter(
				'customBinaryContentType',
				'application/octet-stream',
			) as string;
			requestOptions.body = await this.helpers.getBinaryDataBuffer(inputDataFieldName);
			headers['Content-Type'] = contentType;
			break;
		}
		case 'formData': {
			const payload = getCustomFormDataFields(this);
			const formData = new FormData();

			for (const field of payload) {
				if (field.type === 'binaryFile') {
					if (!field.inputDataFieldName) {
						continue;
					}

					const binaryMetadata = this.helpers.assertBinaryData(field.inputDataFieldName);
					const buffer = await this.helpers.getBinaryDataBuffer(field.inputDataFieldName);
					const blob = new Blob([buffer], {
						type: binaryMetadata.mimeType || 'application/octet-stream',
					});

					formData.append(field.name, blob, binaryMetadata.fileName || field.inputDataFieldName);
					continue;
				}

				formData.append(field.name, stringifyBodyValue(field.value));
			}

			requestOptions.body = formData as unknown as IHttpRequestOptions['body'];
			delete headers['Content-Type'];
			break;
		}
		case 'formUrlencoded': {
			const payload = getCustomParameterPayload(this);
			const params = new URLSearchParams();

			for (const [key, value] of Object.entries(payload)) {
				params.append(key, stringifyBodyValue(value));
			}

			requestOptions.body = params as unknown as IHttpRequestOptions['body'];
			headers['Content-Type'] = 'application/x-www-form-urlencoded';
			break;
		}
		case 'raw': {
			const rawBody = this.getNodeParameter('customRawBody', '') as string;
			const rawContentType = this.getNodeParameter('customRawContentType', 'text/plain') as string;
			requestOptions.body = rawBody;
			headers['Content-Type'] = rawContentType;
			break;
		}
		case 'json':
		default: {
			const bodyValue = this.getNodeParameter('customBody', {}) as IDataObject | string;
			requestOptions.body =
				typeof bodyValue === 'string'
					? (JSON.parse(bodyValue) as IDataObject)
					: ((bodyValue ?? {}) as IDataObject);
			headers['Content-Type'] = 'application/json';
			break;
		}
	}

	requestOptions.headers = headers;
	return requestOptions;
}

/**
 * Builds shared request option expressions for GET/POST routes.
 *
 * These map the node option collection to n8n's HTTP request settings so we can
 * expose familiar HTTP node controls without rewriting the whole node execution layer.
 */
function buildHttpNodeLikeRequestOptions(
	parameterName:
		| typeof CUSTOM_REQUEST_OPTIONS_PARAMETER
		| typeof GET_REQUEST_OPTIONS_PARAMETER
		| typeof POST_REQUEST_OPTIONS_PARAMETER,
) {
	return {
		encoding:
			`={{ $parameter.${parameterName}.responseFormat === "file" ? "arraybuffer" : ($parameter.${parameterName}.responseFormat === "json" ? "json" : ($parameter.${parameterName}.responseFormat === "text" ? "text" : undefined)) }}` as unknown as IHttpRequestOptions['encoding'],
		skipSslCertificateValidation: `={{ $parameter.${parameterName}.ignoreSslIssues ?? false }}` as unknown as boolean,
		disableFollowRedirect: `={{ $parameter.${parameterName}.followRedirects === false }}` as unknown as boolean,
		maxRedirects: `={{ $parameter.${parameterName}.followRedirects === false ? undefined : $parameter.${parameterName}.maxRedirects }}` as unknown as number,
		returnFullResponse: `={{ $parameter.${parameterName}.includeHeadersAndStatus ?? false }}` as unknown as boolean,
		ignoreHttpStatusErrors: `={{ $parameter.${parameterName}.neverError ?? false }}` as unknown as boolean,
		proxy:
			`={{ (() => { const proxyValue = $parameter.${parameterName}.proxy; if (!proxyValue) { return undefined; } const normalized = proxyValue.includes("://") ? proxyValue : "http://" + proxyValue; const parsed = new URL(normalized); return { protocol: parsed.protocol.replace(":", ""), host: parsed.hostname, port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)), auth: parsed.username ? { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) } : undefined }; })() }}` as unknown as NonNullable<
				IHttpRequestOptions['proxy']
			>,
		timeout: `={{ $parameter.${parameterName}.timeout ?? undefined }}` as unknown as number,
	};
}

/**
 * Resolves a selected model id against `/model` response variants.
 *
 * @param models Model list returned by `/model`.
 * @param selectedModelId Value selected in the n8n dropdown.
 * @returns The resolved model id usable for detail calls.
 */
function resolveModelId(models: AirProcessModel[], selectedModelId: string): string {
	const matchingModel = models.find(
		(model) => model.modelID === selectedModelId || model.modelId === selectedModelId || model.id === selectedModelId,
	);
	return matchingModel?.id ?? selectedModelId;
}

/**
 * Fetches models with the credential currently configured on the node.
 *
 * @param loadOptions n8n load-options context.
 * @returns List of models normalized from AirProcess response variants.
 */
async function fetchModels(loadOptions: ILoadOptionsFunctions): Promise<AirProcessModel[]> {
	const credentials = (await loadOptions.getCredentials('airProcessApi')) as { token?: unknown };
	const token = typeof credentials.token === 'string' ? credentials.token.trim() : '';

	const response = await loadOptions.helpers.httpRequestWithAuthentication.call(loadOptions, 'airProcessApi', {
		method: 'GET',
		url: AIRPROCESS_MODELS_URL,
		json: true,
		headers: token.length > 0 ? { Authorization: `Bearer ${token}` } : undefined,
	});

	return extractListFromResponse<AirProcessModel>(response);
}

/**
 * Shared loader used by dynamic field dropdowns ("Create" and "Find records").
 *
 * @param loadOptions n8n load-options context.
 * @param modelIdParameterName Name of the node parameter holding the model id.
 * @param selectedFieldsParameterName Name of the fixedCollection parameter for selected fields.
 * @returns Unique field options for the selected model.
 */
async function getModelFieldOptions(
	loadOptions: ILoadOptionsFunctions,
	modelIdParameterName: 'modelIdCreate' | 'modelIdFind' | 'modelIdPatch',
	selectedFieldsParameterName: 'createFields.field' | 'findFields.field' | 'updateFields.field',
): Promise<INodePropertyOptions[]> {
	const modelId = loadOptions.getCurrentNodeParameter(modelIdParameterName) as string;
	if (!modelId) {
		return [];
	}

	const models = await fetchModels(loadOptions);
	const resolvedModelId = resolveModelId(models, modelId);
	const credentials = (await loadOptions.getCredentials('airProcessApi')) as { token?: unknown };
	const token = typeof credentials.token === 'string' ? credentials.token.trim() : '';

	const response = await loadOptions.helpers.httpRequestWithAuthentication.call(loadOptions, 'airProcessApi', {
		method: 'GET',
		url: `${AIRPROCESS_MODELS_URL}/${resolvedModelId}`,
		json: true,
		headers: token.length > 0 ? { Authorization: `Bearer ${token}` } : undefined,
	});

	const modelData = extractSingleFromResponse<AirProcessModelDetail>(response);
	const fields = extractFieldsFromModelDetail(modelData ?? {});

	// Do not exclude already selected fields from options.
	// Keeping all options ensures n8n can always resolve labels when reopening the node.
	void selectedFieldsParameterName;

	const seen = new Set<string>();
	return fields
		.map(toFieldOption)
		.filter((option): option is INodePropertyOptions => option !== null)
		.filter((option) => {
			if (seen.has(option.value as string)) {
				return false;
			}
			seen.add(option.value as string);
			return true;
		});
}

/**
 * n8n community node for AirProcess.
 * Exposes grouped API routes and dynamic model/field dropdowns.
 */
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
			async getModelFieldsForUpdate(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await getModelFieldOptions(this, 'modelIdPatch', 'updateFields.field');
			},
		},
	};

	description: INodeTypeDescription = {
		displayName: 'AirProcess',
		name: 'airProcess',
		icon: { light: 'file:../../icons/airprocess.svg', dark: 'file:../../icons/airprocess-dark.svg' },
		group: ['input'],
		version: 1,
		subtitle:
			'={{$parameter["resource"] + ": " + ($parameter["modelIdGet"] || $parameter["modelIdCreate"] || $parameter["modelIdFind"] || $parameter["modelIdPatch"] || $parameter["modelIdDelete"] || "")}}',
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
		},
		properties: [
			{
				displayName: 'Route',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Custom API Call',
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
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['get'],
					},
				},
				options: [
					{
						name: 'Find One Model',
						value: 'findOneModel',
						action: 'Find one model',
						routing: {
							request: {
								method: 'GET',
								url: '=/model/{{$parameter.modelIdGetOneModel}}',
								headers: {
									Authorization: AUTHORIZATION_HEADER_EXPRESSION,
								},
								...buildHttpNodeLikeRequestOptions(GET_REQUEST_OPTIONS_PARAMETER),
							},
						},
					},
					{
						name: 'Get a Record',
						value: 'getRecord',
						action: 'Get a record',
						routing: {
							request: {
								method: 'GET',
								url: '=/{{$parameter.modelIdGet}}/{{$parameter.recordIdGet}}',
								headers: {
									Authorization: AUTHORIZATION_HEADER_EXPRESSION,
								},
								...buildHttpNodeLikeRequestOptions(GET_REQUEST_OPTIONS_PARAMETER),
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
								headers: {
									Authorization: AUTHORIZATION_HEADER_EXPRESSION,
								},
								...buildHttpNodeLikeRequestOptions(GET_REQUEST_OPTIONS_PARAMETER),
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
								headers: {
									Authorization: AUTHORIZATION_HEADER_EXPRESSION,
								},
								...buildHttpNodeLikeRequestOptions(GET_REQUEST_OPTIONS_PARAMETER),
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
								headers: {
									Authorization: AUTHORIZATION_HEADER_EXPRESSION,
								},
								...buildHttpNodeLikeRequestOptions(GET_REQUEST_OPTIONS_PARAMETER),
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
								headers: {
									Authorization: AUTHORIZATION_HEADER_EXPRESSION,
								},
								...buildHttpNodeLikeRequestOptions(GET_REQUEST_OPTIONS_PARAMETER),
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
								headers: {
									Authorization: AUTHORIZATION_HEADER_EXPRESSION,
								},
								...buildHttpNodeLikeRequestOptions(GET_REQUEST_OPTIONS_PARAMETER),
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
								headers: {
									Authorization: AUTHORIZATION_HEADER_EXPRESSION,
								},
								...buildHttpNodeLikeRequestOptions(GET_REQUEST_OPTIONS_PARAMETER),
							},
						},
					},
				],
				default: 'getRecords',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['post'],
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
								body: '={{ {} }}' as unknown as IDataObject,
								headers: {
									Authorization: AUTHORIZATION_HEADER_EXPRESSION,
								},
								...buildHttpNodeLikeRequestOptions(POST_REQUEST_OPTIONS_PARAMETER),
							},
							send: {
								preSend: [configureCreateRecordRequest],
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
									Authorization: AUTHORIZATION_HEADER_EXPRESSION,
									'Content-Type': 'application/json',
								},
								...buildHttpNodeLikeRequestOptions(POST_REQUEST_OPTIONS_PARAMETER),
							},
						},
					},
				],
				default: 'createRecord',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['patch'],
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
								body: UPDATE_RECORD_BODY_EXPRESSION,
								headers: {
									Authorization: AUTHORIZATION_HEADER_EXPRESSION,
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
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['delete'],
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
								headers: {
									Authorization: AUTHORIZATION_HEADER_EXPRESSION,
								},
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
									Authorization: AUTHORIZATION_HEADER_EXPRESSION,
									'Content-Type': 'application/json',
								},
							},
						},
					},
				],
				default: 'deleteRecord',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['custom'],
					},
				},
				options: [
					{
						name: 'DELETE',
						value: 'customDelete',
						action: 'Call a custom DELETE route',
						routing: {
							request: {
								method: 'DELETE',
								url: CUSTOM_URL_EXPRESSION,
								body: CUSTOM_BODY_EXPRESSION,
								headers: CUSTOM_HEADERS_EXPRESSION,
							},
						},
					},
					{
						name: 'GET',
						value: 'customGet',
						action: 'Call a custom GET route',
						routing: {
							request: {
								method: 'GET',
								url: CUSTOM_URL_EXPRESSION,
								body: '={{ {} }}' as unknown as IDataObject,
								headers: CUSTOM_HEADERS_EXPRESSION,
								...buildHttpNodeLikeRequestOptions(CUSTOM_REQUEST_OPTIONS_PARAMETER),
							},
							send: {
								preSend: [configureCustomTypedBodyRequest],
							},
							output: {
								postReceive: [
									{
										type: 'binaryData',
										enabled: '={{ $parameter.customRequestOptions.responseFormat === "file" }}',
										properties: {
											destinationProperty:
												'={{ $parameter.customRequestOptions.responseBinaryPropertyName || "data" }}',
										},
									},
								],
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
								url: CUSTOM_URL_EXPRESSION,
								body: CUSTOM_BODY_EXPRESSION,
								headers: CUSTOM_HEADERS_EXPRESSION,
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
								url: CUSTOM_URL_EXPRESSION,
								body: '={{ {} }}' as unknown as IDataObject,
								headers: CUSTOM_HEADERS_EXPRESSION,
								...buildHttpNodeLikeRequestOptions(CUSTOM_REQUEST_OPTIONS_PARAMETER),
							},
							send: {
								preSend: [configureCustomTypedBodyRequest],
							},
							output: {
								postReceive: [
									{
										type: 'binaryData',
										enabled: '={{ $parameter.customRequestOptions.responseFormat === "file" }}',
										properties: {
											destinationProperty:
												'={{ $parameter.customRequestOptions.responseBinaryPropertyName || "data" }}',
										},
									},
								],
							},
						},
					},
				],
				default: 'customGet',
			},
			{
				displayName: 'Options',
				name: CUSTOM_REQUEST_OPTIONS_PARAMETER,
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				displayOptions: {
					show: {
						resource: ['custom'],
						operation: ['customGet', 'customPost'],
					},
				},
				options: [
					{
						displayName: 'Follow Redirects',
						name: 'followRedirects',
						type: 'boolean',
						default: true,
						description: 'Whether to follow HTTP redirects',
					},
					{
						displayName: 'Ignore SSL Issues',
						name: 'ignoreSslIssues',
						type: 'boolean',
						default: false,
						description: 'Whether to allow the request even when SSL certificate validation fails',
					},
					{
						displayName: 'Include Response Headers and Status',
						name: 'includeHeadersAndStatus',
						type: 'boolean',
						default: false,
						description: 'Whether to return the full response instead of only the body',
					},
					{
						displayName: 'Max Redirects',
						name: 'maxRedirects',
						type: 'number',
						default: 21,
						displayOptions: {
							show: {
								followRedirects: [true],
							},
						},
						description: 'Maximum number of redirects to follow',
					},
					{
						displayName: 'Never Error',
						name: 'neverError',
						type: 'boolean',
						default: false,
						description: 'Whether to return the response even when the status code is not 2xx',
					},
					{
						displayName: 'Proxy',
						name: 'proxy',
						type: 'string',
						default: '',
						placeholder: 'http://proxy.example.com:8080',
						description: 'HTTP proxy to use for this request',
					},
					{
						displayName: 'Response Binary Property',
						name: 'responseBinaryPropertyName',
						type: 'string',
						default: 'data',
						displayOptions: {
							show: {
								responseFormat: ['file'],
							},
						},
						description: 'Name of the binary property where the downloaded file will be stored',
					},
					{
						displayName: 'Response Format',
						name: 'responseFormat',
						type: 'options',
						options: [
							{
								name: 'Autodetect',
								value: 'autodetect',
							},
							{
								name: 'File',
								value: 'file',
							},
							{
								name: 'JSON',
								value: 'json',
							},
							{
								name: 'Text',
								value: 'text',
							},
						],
						default: 'autodetect',
						description: 'How to interpret the response body',
					},
					{
						displayName: 'Timeout',
						name: 'timeout',
						type: 'number',
						default: 30000,
						description: 'Time to wait for the initial response in milliseconds',
					},
				],
			},
			{
				displayName: 'Options',
				name: GET_REQUEST_OPTIONS_PARAMETER,
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				displayOptions: {
					show: {
						resource: ['get'],
					},
				},
				options: [
					{
						displayName: 'Follow Redirects',
						name: 'followRedirects',
						type: 'boolean',
						default: true,
						description: 'Whether to follow HTTP redirects',
					},
					{
						displayName: 'Ignore SSL Issues',
						name: 'ignoreSslIssues',
						type: 'boolean',
						default: false,
						description: 'Whether to allow the request even when SSL certificate validation fails',
					},
					{
						displayName: 'Include Response Headers and Status',
						name: 'includeHeadersAndStatus',
						type: 'boolean',
						default: false,
						description: 'Whether to return the full response instead of only the body',
					},
					{
						displayName: 'Max Redirects',
						name: 'maxRedirects',
						type: 'number',
						default: 21,
						displayOptions: {
							show: {
								followRedirects: [true],
							},
						},
						description: 'Maximum number of redirects to follow',
					},
					{
						displayName: 'Never Error',
						name: 'neverError',
						type: 'boolean',
						default: false,
						description: 'Whether to return the response even when the status code is not 2xx',
					},
					{
						displayName: 'Proxy',
						name: 'proxy',
						type: 'string',
						default: '',
						placeholder: 'http://proxy.example.com:8080',
						description: 'HTTP proxy to use for this request',
					},
					{
						displayName: 'Timeout',
						name: 'timeout',
						type: 'number',
						default: 30000,
						description: 'Time to wait for the initial response in milliseconds',
					},
				],
			},
			{
				displayName: 'Options',
				name: POST_REQUEST_OPTIONS_PARAMETER,
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				displayOptions: {
					show: {
						resource: ['post'],
					},
				},
				options: [
					{
						displayName: 'Follow Redirects',
						name: 'followRedirects',
						type: 'boolean',
						default: true,
						description: 'Whether to follow HTTP redirects',
					},
					{
						displayName: 'Ignore SSL Issues',
						name: 'ignoreSslIssues',
						type: 'boolean',
						default: false,
						description: 'Whether to allow the request even when SSL certificate validation fails',
					},
					{
						displayName: 'Include Response Headers and Status',
						name: 'includeHeadersAndStatus',
						type: 'boolean',
						default: false,
						description: 'Whether to return the full response instead of only the body',
					},
					{
						displayName: 'Max Redirects',
						name: 'maxRedirects',
						type: 'number',
						default: 21,
						displayOptions: {
							show: {
								followRedirects: [true],
							},
						},
						description: 'Maximum number of redirects to follow',
					},
					{
						displayName: 'Never Error',
						name: 'neverError',
						type: 'boolean',
						default: false,
						description: 'Whether to return the response even when the status code is not 2xx',
					},
					{
						displayName: 'Proxy',
						name: 'proxy',
						type: 'string',
						default: '',
						placeholder: 'http://proxy.example.com:8080',
						description: 'HTTP proxy to use for this request',
					},
					{
						displayName: 'Timeout',
						name: 'timeout',
						type: 'number',
						default: 30000,
						description: 'Time to wait for the initial response in milliseconds',
					},
				],
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
						resource: ['custom'],
					},
				},
				description: 'Custom route path or full URL',
			},
			{
				displayName: 'Send Headers',
				name: 'customSendHeaders',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						resource: ['custom'],
					},
				},
				description: 'Whether to include custom headers',
			},
			{
				displayName: 'Headers',
				name: 'customHeaders',
				type: 'json',
				default: '{}',
				displayOptions: {
					show: {
						resource: ['custom'],
						customSendHeaders: [true],
					},
				},
				description: 'Custom headers to send with the request',
			},
			{
				displayName: 'Send Body',
				name: 'customSendBody',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						resource: ['custom'],
					},
				},
				description: 'Whether to include a request body',
			},
			{
				displayName: 'Body Content Type',
				name: 'customBodyContentType',
				type: 'options',
				options: [
					{
						name: 'Form URLencoded',
						value: 'formUrlencoded',
					},
					{
						name: 'Form-Data',
						value: 'formData',
					},
					{
						name: 'JSON',
						value: 'json',
					},
					{
						name: 'N8n Binary File',
						value: 'binaryFile',
					},
					{
						name: 'Raw',
						value: 'raw',
					},
				],
				default: 'json',
				displayOptions: {
					show: {
						resource: ['custom'],
						operation: ['customGet', 'customPost'],
						customSendBody: [true],
					},
				},
				description: 'Content type to use for the custom POST body',
			},
			{
				displayName: 'Body',
				name: 'customBody',
				type: 'json',
				default: '{}',
				displayOptions: {
					show: {
						resource: ['custom'],
						operation: ['customGet', 'customPost'],
						customSendBody: [true],
						customBodyContentType: ['json'],
					},
				},
				description: 'JSON body sent to AirProcess',
			},
			{
				displayName: 'Body Parameters',
				name: 'customFormFields',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				placeholder: 'Add Parameter',
				default: {
					parameter: [],
				},
				displayOptions: {
					show: {
						resource: ['custom'],
						operation: ['customGet', 'customPost'],
						customSendBody: [true],
						customBodyContentType: ['formUrlencoded'],
					},
				},
				options: [
					{
						name: 'parameter',
						displayName: 'Parameter',
						values: [
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								default: '',
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
				description: 'Parameters to include in the URL-encoded body',
			},
			{
				displayName: 'Body',
				name: 'customFormDataFields',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				placeholder: 'Add Body Field',
				default: {
					bodyField: [],
				},
				displayOptions: {
					show: {
						resource: ['custom'],
						operation: ['customGet', 'customPost'],
						customSendBody: [true],
						customBodyContentType: ['formData'],
					},
				},
				options: [
					{
						name: 'bodyField',
						displayName: 'Body Field',
						values: [
							{
								displayName: 'Type',
								name: 'type',
								type: 'options',
								options: [
									{
										name: 'Form Data',
										value: 'formData',
									},
									{
										name: 'N8n Binary File',
										value: 'binaryFile',
									},
								],
								default: 'formData',
							},
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								default: '',
							},
							{
								displayName: 'Input Data Field Name',
								name: 'inputDataFieldName',
								type: 'string',
								default: 'data',
								displayOptions: {
									show: {
										type: ['binaryFile'],
									},
								},
								description: 'Binary property from the incoming item to attach to the form-data body',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								displayOptions: {
									show: {
										type: ['formData'],
									},
								},
							},
						],
					},
				],
				description: 'Fields to include in the form-data body',
			},
			{
				displayName: 'Input Data Field Name',
				name: 'customBinaryInputDataFieldName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: {
					show: {
						resource: ['custom'],
						operation: ['customGet', 'customPost'],
						customSendBody: [true],
						customBodyContentType: ['binaryFile'],
					},
				},
				description: 'Name of the incoming binary property to send as the request body',
			},
			{
				displayName: 'Content Type',
				name: 'customBinaryContentType',
				type: 'string',
				default: 'application/octet-stream',
				displayOptions: {
					show: {
						resource: ['custom'],
						operation: ['customGet', 'customPost'],
						customSendBody: [true],
						customBodyContentType: ['binaryFile'],
					},
				},
				description: 'Content-Type header to use for the binary body',
			},
			{
				displayName: 'Content Type',
				name: 'customRawContentType',
				type: 'string',
				default: 'text/plain',
				required: true,
				displayOptions: {
					show: {
						resource: ['custom'],
						operation: ['customGet', 'customPost'],
						customSendBody: [true],
						customBodyContentType: ['raw'],
					},
				},
				description: 'Content-Type header to use for the raw body',
			},
			{
				displayName: 'Body',
				name: 'customRawBody',
				type: 'string',
				typeOptions: {
					rows: 5,
				},
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['custom'],
						operation: ['customGet', 'customPost'],
						customSendBody: [true],
						customBodyContentType: ['raw'],
					},
				},
				description: 'Raw body content sent to AirProcess',
			},
			{
				displayName: 'Model Name or ID',
				name: 'modelIdGetOneModel',
				type: 'options',
				required: true,
				typeOptions: {
					loadOptionsMethod: 'getModels',
				},
				default: '',
				displayOptions: {
					show: {
						resource: ['get'],
						operation: ['findOneModel'],
					},
				},
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
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
						resource: ['get'],
						operation: ['getRecord', 'getRecords'],
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
						resource: ['post'],
						operation: ['createRecord'],
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
						resource: ['post'],
						operation: ['findRecordsMongo'],
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
						resource: ['patch'],
						operation: ['updateRecord'],
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
						resource: ['delete'],
						operation: ['deleteRecord', 'sendToTrash'],
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
						resource: ['get'],
						operation: ['getRecord'],
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
						resource: ['patch'],
						operation: ['updateRecord'],
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
						resource: ['delete'],
						operation: ['deleteRecord', 'sendToTrash'],
					},
				},
				description: 'Record identifier used in the path',
			},
			{
				displayName: 'Body Content Type',
				name: 'createBodyContentType',
				type: 'options',
				options: [
					{
						name: 'Form URLencoded',
						value: 'formUrlencoded',
					},
					{
						name: 'Form-Data',
						value: 'formData',
					},
					{
						name: 'JSON',
						value: 'json',
					},
					{
						name: 'N8n Binary File',
						value: 'binaryFile',
					},
					{
						name: 'Raw',
						value: 'raw',
					},
				],
				default: 'json',
				displayOptions: {
					show: {
						resource: ['post'],
						operation: ['createRecord'],
					},
				},
				description: 'Content type to use for the POST body',
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
						resource: ['post'],
						operation: ['createRecord'],
						createBodyContentType: ['json'],
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
						resource: ['post'],
						operation: ['createRecord'],
						createBodyContentType: ['json'],
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
						resource: ['post'],
						operation: ['createRecord'],
						createBodyContentType: ['json'],
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
				displayName: 'Body Parameters',
				name: 'createFormFields',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				placeholder: 'Add Parameter',
				default: {
					field: [],
				},
				displayOptions: {
					show: {
						resource: ['post'],
						operation: ['createRecord'],
						createBodyContentType: ['formUrlencoded', 'formData'],
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
									loadOptionsDependsOn: ['modelIdCreate', 'createFormFields.field'],
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
				displayName: 'Input Data Field Name',
				name: 'createBinaryInputDataFieldName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: {
					show: {
						resource: ['post'],
						operation: ['createRecord'],
						createBodyContentType: ['binaryFile'],
					},
				},
				description: 'Name of the incoming binary property to send as the request body',
			},
			{
				displayName: 'Content Type',
				name: 'createBinaryContentType',
				type: 'string',
				default: 'application/octet-stream',
				displayOptions: {
					show: {
						resource: ['post'],
						operation: ['createRecord'],
						createBodyContentType: ['binaryFile'],
					},
				},
				description: 'Content-Type header to use for the binary body',
			},
			{
				displayName: 'Content Type',
				name: 'createRawContentType',
				type: 'string',
				default: 'text/plain',
				required: true,
				displayOptions: {
					show: {
						resource: ['post'],
						operation: ['createRecord'],
						createBodyContentType: ['raw'],
					},
				},
				description: 'Content-Type header to use for the raw body',
			},
			{
				displayName: 'Body',
				name: 'createRawBody',
				type: 'string',
				typeOptions: {
					rows: 5,
				},
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['post'],
						operation: ['createRecord'],
						createBodyContentType: ['raw'],
					},
				},
				description: 'Raw body content sent to AirProcess',
			},
			{
				displayName: 'Specify Body',
				name: 'updateBodyMode',
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
						resource: ['patch'],
						operation: ['updateRecord'],
					},
				},
				description: 'Choose whether to send raw JSON or build the body from fields',
			},
			{
				displayName: 'Body',
				name: 'bodyUpdate',
				type: 'json',
				required: true,
				default: '{\n  "kdx42bqx": "Bob wilson"\n}',
				displayOptions: {
					show: {
						resource: ['patch'],
						operation: ['updateRecord'],
						updateBodyMode: ['json'],
					},
				},
				description: 'JSON body sent to AirProcess',
			},
			{
				displayName: 'Fields',
				name: 'updateFields',
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
						resource: ['patch'],
						operation: ['updateRecord'],
						updateBodyMode: ['fields'],
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
									loadOptionsMethod: 'getModelFieldsForUpdate',
									loadOptionsDependsOn: ['modelIdPatch', 'updateFields.field'],
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
				displayName: 'Skip',
				name: 'findSkip',
				type: 'number',
				required: true,
				default: 0,
				displayOptions: {
					show: {
						resource: ['post'],
						operation: ['findRecordsMongo'],
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
						resource: ['post'],
						operation: ['findRecordsMongo'],
					},
				},
				description: 'Maximum number of records to return',
			},
			{
				displayName: 'Specify Filters',
				name: 'findFilterMode',
				type: 'options',
				options: [
					{
						name: 'Using Fields Below',
						value: 'fields',
					},
					{
						name: 'JSON',
						value: 'json',
					},
				],
				default: 'fields',
				displayOptions: {
					show: {
						resource: ['post'],
						operation: ['findRecordsMongo'],
					},
				},
				description: 'Choose whether to build filters from fields or send raw JSON',
			},
			{
				displayName: 'Filters (JSON)',
				name: 'findFilterJson',
				type: 'json',
				default: '{\n  "flddHGP8O6VWZGpaj": "Done"\n}',
				displayOptions: {
					show: {
						resource: ['post'],
						operation: ['findRecordsMongo'],
						findFilterMode: ['json'],
					},
				},
				description: 'Mongo filter JSON sent in the "filter" property',
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
						resource: ['post'],
						operation: ['findRecordsMongo'],
						findFilterMode: ['fields'],
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
		],
	};
}



