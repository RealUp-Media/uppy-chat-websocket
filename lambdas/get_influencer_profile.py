"""
 * @summary Returns the influencer display name using id_influencer_main from Cognito (JWT claims and/or GetUser); never from client-supplied influencer id.
 *
 * @receives {object} event - API Gateway request after JWT authorizer validation, with Authorization: Bearer <token>. Cognito access tokens usually omit custom claims in jwt.claims; this Lambda then loads attributes via cognito-idp:GetUser. ID tokens may include custom:id_influencer_main in claims directly.
 *
 * @example Request (HTTP):
 * Authorization: Bearer <Cognito access token or ID token>
 *
 * @returns {object} HTTP-style object with statusCode and JSON body containing name and id_influencer_main, or an error message.
 *
 * @example Response:
 * {
 *   "statusCode": 200,
 *   "body": {
 *     "id_influencer_main": "f712ce49-2534-4e0a-8a86-b4bfd14f182a",
 *     "name": "Leo Messiii"
 *   }
 * }
"""

import json
import os
import logging
import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

_REGION = os.environ.get("AWS_REGION", "us-east-1")

dynamodb = boto3.resource(
    "dynamodb",
    region_name=_REGION,
)

cognito_idp = boto3.client("cognito-idp", region_name=_REGION)

INFLUENCER_MAIN_TABLE = os.environ.get(
    "INFLUENCER_MAIN_TABLE_NAME", "uppy_influencer_main"
)

CUSTOM_INFLUENCER_ID_KEY = "custom:id_influencer_main"


def _get_bearer_token(event):
    """Read Bearer token from API Gateway headers (v1 or v2; case-insensitive)."""
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
    """
    Cognito access tokens rarely expose custom attributes inside the JWT payload
    that API Gateway copies to jwt.claims. GetUser(AccessToken=...) returns them.
    Requires IAM cognito-idp:GetUser on the Lambda role.
    """
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
    """
    Resolve id_influencer_main from JWT claims (e.g. ID token), Cognito trigger
    attributes, or cognito-idp:GetUser with the same Bearer token (access token).
    """
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


def get_influencer_name_by_id(id_influencer_main):
    """
    Load influencer row from DynamoDB and return the display name.

    Returns:
        tuple: (name: str | None, item: dict | None) — item is the full row if found.
    """
    table = dynamodb.Table(INFLUENCER_MAIN_TABLE)
    try:
        result = table.get_item(Key={"id_influencer_main": id_influencer_main})
    except ClientError as e:
        logger.error("DynamoDB get_item failed: %s", e)
        raise

    item = result.get("Item")
    if not item:
        return None, None
    name = item.get("name")
    return name, item


def lambda_handler(event, context):
    try:
        logger.info("get_influencer_profile invoked")

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
                        "JWT includes that claim. Expired or wrong token types (e.g. "
                        "refresh token) will fail."
                    ),
                },
            )

        name, item = get_influencer_name_by_id(influencer_id)
        if item is None:
            return _response(
                404,
                {
                    "error": "Not found",
                    "message": "No influencer record for the authenticated user",
                    "id_influencer_main": influencer_id,
                },
            )

        return _response(
            200,
            {
                "id_influencer_main": influencer_id,
                "name": name,
            },
        )

    except ClientError:
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
