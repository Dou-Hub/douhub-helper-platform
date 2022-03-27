

import { USER , ORGANIZATION , TAGS_BASE , TAGS_COLORS ,TAGS_NAMES } from 'douhub-helper-data';
import { cloneDeep } from 'lodash';
import { isNonEmptyString, _track, utcISOString } from 'douhub-helper-util';
import { APIGatewayProxyEvent } from 'aws-lambda';
import {
    HTTPERROR_400, getPropValueOfEvent, HTTPERROR_500, 
    ERROR_PARAMETER_INVALID, ERROR_PARAMETER_MISSING, createUserToken,
    S3_DATA_BUCKET, DYNAMO_DB_PROFILE_TABLE
} from 'douhub-helper-lambda';
import { 
    cosmosDBRetrieveById, cosmosDBUpsert, dynamoDBCreate, 
    createCognitoUser,
    dynamoDBRetrieve, getSecretValue, 
    s3Exist, s3PutObject } from 'douhub-helper-service';

export const checkInitKey = async (event: APIGatewayProxyEvent) => {
    const source = 'checkInitKey';
    const key = getPropValueOfEvent(event, 'key');

    if (!isNonEmptyString(key)) {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source,
            detail: {
                reason: 'key',
                parameters: { key }
            }
        }
    }

    if (key != (await getSecretValue('INIT_KEY'))) {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_INVALID,
            source,
            detail: {
                reason: 'key',
                parameters: { key }
            }
        }
    }

    return key;
};

export const initPlatform = async (
    solutionId: string, 
    organizationId: string, 
    userId: string, 
    email: string, 
    password: string,
    userPoolId: string,
    userPoolLambdaClientId: string
    ) => {

    const source = 'platformn.init'
    const utcNow = utcISOString();

    if (!isNonEmptyString(email)) {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source,
            detail: {
                reason: 'email',
                parameters: { email }
            }
        }
    }
    
    if (!isNonEmptyString(password)) {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source,
            detail: {
                reason: 'password',
                parameters: { password }
            }
        }
    }
    
    if (!isNonEmptyString(userPoolId) || !isNonEmptyString(userPoolLambdaClientId)) {
        throw {
            ...HTTPERROR_400,
            type: ERROR_PARAMETER_MISSING,
            source,
            detail: {
                reason: 'Both userPoolId and userPoolLambdaClientId are required.',
                parameters: { userPoolId,userPoolLambdaClientId }
            }
        }
    }

    try {

        let user:Record<string,any> = cloneDeep(USER);

        user.id = userId;
        user.solutionId = solutionId;
        user.organizationId = organizationId;
        user.partitionKey = organizationId;

        user.createdOn = utcNow;
        user.ownedOn = utcNow;
        user.modifiedOn = utcNow;
        user.ownedBy = userId;
        user.createdBy = userId;
        user.modifiedBy = userId;

        user.email = email;

        let organization:Record<string,any> = cloneDeep(ORGANIZATION);
        organization.id = organizationId;
        organization.solutionId = solutionId;
        organization.organizationId = organizationId;
        organization.partitionKey = organizationId;

        organization.createdOn = utcNow;
        organization.ownedOn = utcNow;
        organization.modifiedOn = utcNow;
        organization.ownedBy = userId;
        organization.createdBy = userId;
        organization.modifiedBy = userId;


        //START: ORGANIZATION

        //Create Organization in CosmosDB
        if (_track) console.log('retrieve organization from cosmosDB.');
        if (!(await cosmosDBRetrieveById(organizationId))) {
            if (_track) console.log('create organization in cosmosDB.');
            await cosmosDBUpsert(organization);
        }
        
        if (_track) console.log('retrieve organization from dynamoDB.', DYNAMO_DB_PROFILE_TABLE);
        //Create Organization in DynamoDB
        const organizationIdinDynamoDb = `organization.${organizationId}`;
        if (!await dynamoDBRetrieve(organizationIdinDynamoDb, DYNAMO_DB_PROFILE_TABLE)) {
            //create organization in dynamoDb
            if (_track) console.log('create organization in dynamoDB.', DYNAMO_DB_PROFILE_TABLE);
            await dynamoDBCreate({ ...organization, id: organizationIdinDynamoDb }, DYNAMO_DB_PROFILE_TABLE);
        }
       
        if (_track) console.log('read organization s3 file.', S3_DATA_BUCKET);
        //Create Organization in S3 data bucket
        const s3OrganizationFileName = `${solutionId}/${organizationId}/Organization/${organizationId}.json`;
        if (!await s3Exist(S3_DATA_BUCKET, s3OrganizationFileName)) {
            if (_track) console.log('create organization s3 file.', S3_DATA_BUCKET);
            await s3PutObject(S3_DATA_BUCKET, s3OrganizationFileName, organization);
        }

        //END: ORGANIZATION

        //START: USER

        //Create User in CosmosDB
        if (_track) console.log('retrieve user from cosmosDB.');
        if (!await cosmosDBRetrieveById(userId)) {
            if (_track) console.log('create user in cosmosDB.');
            await cosmosDBUpsert(user); 
        }

        if (_track) console.log('retrieve user from dynamoDB.', DYNAMO_DB_PROFILE_TABLE);
        //Create User in DynamoDB
        const userIdinDynamoDb = `user.${userId}`;
        if (!await dynamoDBRetrieve (userIdinDynamoDb, DYNAMO_DB_PROFILE_TABLE)) {
            if (_track) console.log('create user in dynamoDB.', DYNAMO_DB_PROFILE_TABLE);
            await dynamoDBCreate({ ...user, id: userIdinDynamoDb }, DYNAMO_DB_PROFILE_TABLE);
        }

        if (_track) console.log('create user token in dynamoDB.', DYNAMO_DB_PROFILE_TABLE);
        //Create User Token in DynamoDB
        await createUserToken( userId, organizationId, [
                'Solution-Admin',
                'ORG-ADMIN'
            ]
        );

        if (_track) console.log('read user s3 file.', S3_DATA_BUCKET);
        //Create User in S3 data bucket
        const s3UserFileName = `${solutionId}/${organizationId}/User/${userId}.json`;
        if (! await s3Exist(S3_DATA_BUCKET, s3UserFileName)) {
            if (_track) console.log('create user s3 file.', S3_DATA_BUCKET);
            await s3PutObject(S3_DATA_BUCKET, s3UserFileName, user);
        }

        //END: USER

        //START: TAGS

        if (_track) console.log('read TAGS_BASE s3 file.', S3_DATA_BUCKET);
        const s3TagsBaseFileName = `${solutionId}/Platform/tags-base.json`;
        if (!await s3Exist(S3_DATA_BUCKET, s3TagsBaseFileName)) {
            if (_track) console.log('create TAGS_BASE s3 file.', S3_DATA_BUCKET);
            await s3PutObject(S3_DATA_BUCKET, s3TagsBaseFileName, TAGS_BASE);
        }

        if (_track) console.log('read TAGS_COLORS s3 file.', S3_DATA_BUCKET);
        const s3TagsColorsFileName = `${solutionId}/Platform/tags-colors.json`;
        if (!await s3Exist(S3_DATA_BUCKET, s3TagsColorsFileName)) {
            if (_track) console.log('create TAGS_COLORS s3 file.', S3_DATA_BUCKET);
            await s3PutObject(S3_DATA_BUCKET, s3TagsColorsFileName, TAGS_COLORS);
        }

        if (_track) console.log('read TAGS_NAMES s3 file.', S3_DATA_BUCKET);
        const s3TagsNamesFileName = `${solutionId}/Platform/tags-names.json`;
        if (!await s3Exist(S3_DATA_BUCKET, s3TagsNamesFileName)) {
            if (_track) console.log('create TAGS_NAMES s3 file.', S3_DATA_BUCKET);
            await s3PutObject(S3_DATA_BUCKET, s3TagsNamesFileName, TAGS_NAMES);
        }

        //END: TAGS

        try {

            if (_track) console.log('Create Cognito user.', userPoolId, userPoolLambdaClientId);

            await createCognitoUser(
                userPoolId,
                userPoolLambdaClientId,
                organizationId,
                userId,
                password
            );
        }
        catch (createUserError:any) {
            if (createUserError.code != 'UsernameExistsException') throw createUserError;
        }

        return { userId, solutionId, organizationId };
    }
    catch (error) {
        if (_track) console.error(error);
        throw {
            ...HTTPERROR_500,
            type: '',
            source,
            detail: {
                error
            }
        }
    }

};
