"""
 * @summary Returns all social profile rows for the authenticated influencer from uppy_influencer via GSI influencer-main-index, keyed by custom:id_influencer_main from Cognito (JWT claims, trigger attrs, or cognito-idp:GetUser).
 *
 * @receives {object} event - API Gateway request with Authorization: Bearer <Cognito access token or ID token>. Env INFLUENCER_TABLE_NAME (default uppy_influencer), INFLUENCER_MAIN_GSI_NAME (default influencer-main-index).
 *
 * @example Request (HTTP):
 * Authorization: Bearer <Cognito access token or ID token>
 *
 * @returns {object} HTTP response with statusCode and JSON body: id_influencer_main and social_networks (array of DynamoDB items for each platform).
 *
 * @example Response:
 * {
 *   "statusCode": 200,
 *   "body": {
 *     "id_influencer_main": "f712ce49-2534-4e0a-8a86-b4bfd14f182a",
 *     "social_networks": [
 *       {
 *         "id_influencer": "a33e9c25-3e79-472e-88eb-37a85b0b96c1",
 *         "followers": 511830624,
 *         "platform": "instagram",
 *         "username": "leomessi",
 *         "url_social_network": "https://www.instagram.com/leomessi/"
 *       }
 *     ]
 *   }
 * }
"""

import json
import logging
import os

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

_REGION = os.environ.get("AWS_REGION", "us-east-1")

dynamodb = boto3.resource("dynamodb", region_name=_REGION)
cognito_idp = boto3.client("cognito-idp", region_name=_REGION)

INFLUENCER_TABLE = os.environ.get("INFLUENCER_TABLE_NAME", "uppy_influencer")
INFLUENCER_MAIN_GSI_NAME = os.environ.get(
    "INFLUENCER_MAIN_GSI_NAME", "influencer-main-index"
)

CUSTOM_INFLUENCER_ID_KEY = "custom:id_influencer_main"


def _get_bearer_token(event):
    headers = event.get("headers") or {}
    auth = None
    for key, val in headers.items():
        if key.lower() == "authorization":
            auth = val
            break
    if not auth:
        mvh = event.get("multiValueHeaders") or {}
        for key, vals in mvh.items():
            if key.lower() == "authorization" and vals:
                auth = vals[0]
                break
    if not auth or not isinstance(auth, str):
        return None
    auth = auth.strip()
    lower = auth.lower()
    if lower.startswith("bearer "):
        return auth[7:].strip() or None
    return None


def _influencer_id_from_jwt_claims(event):
    rc = event.get("requestContext") or {}
    authorizer = rc.get("authorizer") or {}
    claims = authorizer.get("claims") or {}
    if not claims and authorizer.get("jwt"):
        claims = (authorizer.get("jwt") or {}).get("claims") or {}
    from_claims = claims.get(CUSTOM_INFLUENCER_ID_KEY)
    if from_claims:
        return str(from_claims).strip() or None
    return None


def _influencer_id_from_cognito_trigger(event):
    user_attrs = (event.get("request") or {}).get("userAttributes") or {}
    from_attrs = user_attrs.get(CUSTOM_INFLUENCER_ID_KEY)
    if from_attrs:
        return str(from_attrs).strip() or None
    return None


def _influencer_id_from_get_user(access_token):
    if not access_token:
        return None
    try:
        resp = cognito_idp.get_user(AccessToken=access_token)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        logger.info("cognito-idp GetUser not used or failed: %s", code)
        return None
    for attr in resp.get("UserAttributes", []):
        if attr.get("Name") == CUSTOM_INFLUENCER_ID_KEY:
            v = attr.get("Value")
            return str(v).strip() if v else None
    return None


def _extract_influencer_id_from_verified_identity(event):
    influencer_id = _influencer_id_from_jwt_claims(event)
    if influencer_id:
        return influencer_id
    influencer_id = _influencer_id_from_cognito_trigger(event)
    if influencer_id:
        return influencer_id
    bearer = _get_bearer_token(event)
    return _influencer_id_from_get_user(bearer)


def _response(status_code, payload_dict):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(payload_dict, default=str),
    }


def list_social_networks_by_main_id(id_influencer_main):
    """
    Query all platform rows for this main influencer id (GSI sort key: followers).

    Returns:
        list[dict]: Items from uppy_influencer (one per linked social account).
    """
    table = dynamodb.Table(INFLUENCER_TABLE)
    items = []
    kwargs = {
        "IndexName": INFLUENCER_MAIN_GSI_NAME,
        "KeyConditionExpression": Key("id_influencer_main").eq(id_influencer_main),
    }
    while True:
        try:
            page = table.query(**kwargs)
        except ClientError:
            raise
        items.extend(page.get("Items", []))
        lek = page.get("LastEvaluatedKey")
        if not lek:
            break
        kwargs["ExclusiveStartKey"] = lek
    return items


def lambda_handler(event, context):
    try:
        logger.info("get_influencer_social_networks invoked")

        influencer_id = _extract_influencer_id_from_verified_identity(event)
        if not influencer_id:
            return _response(
                401,
                {
                    "error": "Unauthorized",
                    "message": (
                        "Could not resolve influencer id for this user. "
                        f"Use Authorization: Bearer with your Cognito access token "
                        f"(Lambda loads {CUSTOM_INFLUENCER_ID_KEY} via GetUser; ensure "
                        "the Lambda role has cognito-idp:GetUser), or an ID token whose "
                        "JWT includes that claim."
                    ),
                },
            )

        social_networks = list_social_networks_by_main_id(influencer_id)

        return _response(
            200,
            {
                "id_influencer_main": influencer_id,
                "social_networks": social_networks,
            },
        )

    except ClientError:
        logger.exception("DynamoDB query failed")
        return _response(
            500,
            {"error": "Internal server error", "message": "Database error"},
        )
    except Exception as e:
        logger.exception("Unexpected error: %s", e)
        return _response(
            500,
            {"error": "Internal server error", "message": str(e)},
        )
