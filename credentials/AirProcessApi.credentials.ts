import type { ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

export class AirProcessApi implements ICredentialType {
	name = 'airProcessApi';

	displayName = 'AirProcess API';

	documentationUrl = 'https://app.airprocess.com/';

	icon = {
		light: 'file:../icons/airprocess.svg',
		dark: 'file:../icons/airprocess.dark.svg',
	} as const;

	properties: INodeProperties[] = [
		{
			displayName: 'API Token',
			name: 'token',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			required: false,
		},
	];

	authenticate = {
		type: 'generic' as const,
		properties: {
			headers: {
				Authorization: '={{ $credentials.token ? "Bearer " + $credentials.token : undefined }}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://app.airprocess.com',
			url: '/model',
			method: 'GET',
		},
	};
}
