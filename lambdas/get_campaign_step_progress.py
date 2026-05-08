"""
 * @summary Returns which campaign flow steps an influencer has completed vs total steps, using uppy_campaign_flow, uppy_enrollment, campaign_name and invoice_id from uppy_campaigns, and currency derived from uppy_invoice.billing_country. Authenticated user is resolved from Bearer token via custom:id_influencer_main (JWT claims, trigger attrs, or cognito-idp:GetUser). If campaign_id is omitted, returns progress for every campaign the influencer is enrolled in.
 *
 * @receives {object} event - API Gateway request with Authorization: Bearer <token>. Optional id_campaign via path (campaign_id), query (campaign_id / campaignId), or JSON body. Optional env ENROLLMENT_INFLUENCER_GSI_NAME: GSI partition key id_influencer for listing enrollments; if unset, uses a paginated Scan filtered by id_influencer. Env CAMPAIGNS_TABLE_NAME (default uppy_campaigns): partition key id_campaign. Env INVOICE_TABLE_NAME (default uppy_invoice): partition key invoice_id.
 *
 * @example Request (query params, single campaign):
 * GET /...?campaign_id=4bcbf762-f973-46d7-80ac-193bd81a546a
 * Authorization: Bearer <Cognito access token or ID token>
 *
 * @example Request (all campaigns):
 * GET /...
 * Authorization: Bearer <Cognito access token or ID token>
 *
 * @returns {object} HTTP response with statusCode and JSON body. Single-campaign shape unchanged; all-campaigns shape includes campaigns array.
 *
 * @example Response (single campaign):
 * {
 *   "statusCode": 200,
 *   "body": {
 *     "id_campaign": "4bcbf762-f973-46d7-80ac-193bd81a546a",
 *     "campaign_name": "My campaign",
 *     "currency": "USD",
 *     "negotiated_amount": 600,
 *     "id_influencer": "f712ce49-2534-4e0a-8a86-b4bfd14f182a",
 *     "current_step_id": "ENVIO_DE_METRICAS",
 *     "completed_step_ids": ["MENSAJE_DE_BIENVENIDA", "SEGUNDO_PASO", "ENVIO_DE_CONTENIDO_1"],
 *     "completed_count": 3,
 *     "total_steps": 5,
 *     "steps": [{ "step_id": "...", "name": "...", "order": 1, "step_type": "buttons", "text": "...", "completed": true, "is_current": false }]
 *   }
 * }
 *
 * @example Response (all campaigns):
 * {
 *   "statusCode": 200,
 *   "body": {
 *     "id_influencer_main": "f712ce49-2534-4e0a-8a86-b4bfd14f182a",
 *     "campaign_count": 2,
 *     "campaigns": [{ "id_campaign": "...", "steps": [...], ... }]
 *   }
 * }
"""

import json
import logging
import os

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

_REGION = os.environ.get("AWS_REGION", "us-east-1")

dynamodb = boto3.resource("dynamodb", region_name=_REGION)
cognito_idp = boto3.client("cognito-idp", region_name=_REGION)
s3_client = boto3.client("s3", region_name=_REGION)

CAMPAIGN_MESSAGES_BUCKET = os.environ.get(
    "CAMPAIGN_MESSAGES_BUCKET", "uppy-campaign-messages"
)

CAMPAIGN_FLOW_TABLE = os.environ.get(
    "CAMPAIGN_FLOW_TABLE_NAME", "uppy_campaign_flow"
)
ENROLLMENT_TABLE = os.environ.get("ENROLLMENT_TABLE_NAME", "uppy_enrollment")
INFLUENCER_TABLE = os.environ.get("INFLUENCER_TABLE_NAME", "uppy_influencer")
# Optional GSI on uppy_enrollment with partition key id_influencer (recommended for "all campaigns").
ENROLLMENT_INFLUENCER_GSI_NAME = os.environ.get(
    "ENROLLMENT_INFLUENCER_GSI_NAME", ""
).strip()
CAMPAIGNS_TABLE_NAME = os.environ.get("CAMPAIGNS_TABLE_NAME", "uppy_campaigns")
INVOICE_TABLE_NAME = os.environ.get("INVOICE_TABLE_NAME", "uppy_invoice")

CUSTOM_INFLUENCER_ID_KEY = "custom:id_influencer_main"

# billing_country (invoice) -> ISO 4217 code; unknown -> resolved as "-" downstream
_BILLING_COUNTRY_TO_CURRENCY = {
    "United States": "USD",
    "United States of America": "USD",
    "USA": "USD",
    "US": "USD",
    "Mexico": "MXN",
    "Colombia": "COP",
    "Argentina": "ARS",
    "Brazil": "BRL",
    "Chile": "CLP",
    "Peru": "PEN",
    "Perú": "PEN",
    "Ecuador": "USD",
    "Venezuela": "VES",
    "Uruguay": "UYU",
    "Paraguay": "PYG",
    "Bolivia": "BOB",
    "Costa Rica": "CRC",
    "Panama": "USD",
    "Panamá": "USD",
    "Guatemala": "GTQ",
    "Honduras": "HNL",
    "El Salvador": "USD",
    "Nicaragua": "NIO",
    "Dominican Republic": "DOP",
    "Puerto Rico": "USD",
    "Spain": "EUR",
    "España": "EUR",
    "United Kingdom": "GBP",
    "UK": "GBP",
    "Canada": "CAD",
    "Germany": "EUR",
    "France": "EUR",
    "Italy": "EUR",
    "Netherlands": "EUR",
    "Portugal": "EUR",
    "Belgium": "EUR",
    "Ireland": "EUR",
    "Austria": "EUR",
    "Switzerland": "CHF",
    "Sweden": "SEK",
    "Norway": "NOK",
    "Denmark": "DKK",
    "Poland": "PLN",
    "Australia": "AUD",
    "New Zealand": "NZD",
    "Japan": "JPY",
    "South Korea": "KRW",
    "Korea, Republic of": "KRW",
    "India": "INR",
    "China": "CNY",
    "Singapore": "SGD",
    "Hong Kong": "HKD",
    "Israel": "ILS",
    "United Arab Emirates": "AED",
    "Saudi Arabia": "SAR",
    "South Africa": "ZAR",
}


def _currency_from_billing_country(billing_country):
    if billing_country is None or billing_country == "":
        return "-"
    s = str(billing_country).strip()
    if s in _BILLING_COUNTRY_TO_CURRENCY:
        return _BILLING_COUNTRY_TO_CURRENCY[s]
    lower_map = {k.lower(): v for k, v in _BILLING_COUNTRY_TO_CURRENCY.items()}
    return lower_map.get(s.lower(), "-")


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
        logger.info("cognito-idp GetUser failed: %s", code)
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


def _extract_campaign_id(event):
    path_params = event.get("pathParameters") or {}
    campaign_id = path_params.get("campaign_id") or path_params.get("campaignId")
    if not campaign_id:
        qs = event.get("queryStringParameters") or {}
        campaign_id = qs.get("campaign_id") or qs.get("campaignId")
    if not campaign_id:
        body = event.get("body")
        if isinstance(body, str):
            try:
                body = json.loads(body) if body else {}
            except json.JSONDecodeError:
                body = {}
        body = body or {}
        campaign_id = body.get("campaign_id") or body.get("campaignId")
    return str(campaign_id).strip() if campaign_id else None


def _response(status_code, payload_dict):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(payload_dict, default=str),
    }


def _next_step_id_from_transitions(step):
    t = step.get("transitions") or {}
    if not isinstance(t, dict):
        return None
    for key in ("accept", "submit", "reject"):
        raw = t.get(key)
        if raw is None:
            continue
        nxt = str(raw).strip()
        if nxt:
            return nxt
    return None


def _canonical_path_step_ids(steps):
    """
    Walk the main path from the lowest-order step following accept -> submit -> reject.
    Flow graphs may not be sorted by `order` along the real path; this matches initialize_flow's start (order 1).
    """
    if not steps or not isinstance(steps, list):
        return []
    sorted_steps = sorted(steps, key=lambda x: x.get("order", 0))
    by_id = {}
    for s in steps:
        sid = s.get("step_id")
        if sid:
            by_id[sid] = s
    if not sorted_steps:
        return []
    start_id = sorted_steps[0].get("step_id")
    if not start_id:
        return []
    path = []
    visited = set()
    cur = start_id
    while cur and cur not in visited:
        visited.add(cur)
        path.append(cur)
        step = by_id.get(cur)
        if not step:
            break
        nxt = _next_step_id_from_transitions(step)
        if not nxt:
            break
        cur = nxt
    return path


def _completed_step_ids_from_path(canonical_path, current_step_id):
    if not canonical_path or not current_step_id:
        return []
    try:
        idx = canonical_path.index(current_step_id)
    except ValueError:
        return []
    return canonical_path[:idx]


def _fallback_completed_by_order(steps, current_step_id):
    by_id = {s.get("step_id"): s for s in steps if s.get("step_id")}
    cur = by_id.get(current_step_id)
    if not cur:
        return []
    cur_order = cur.get("order")
    if cur_order is None:
        return []
    completed = []
    for s in steps:
        sid = s.get("step_id")
        o = s.get("order")
        if sid and o is not None and o < cur_order:
            completed.append(sid)
    return completed


def _resolve_candidate_influencer_ids(id_influencer_main):
    candidate_ids = [id_influencer_main]
    try:
        inf_table = dynamodb.Table(INFLUENCER_TABLE)
        q = inf_table.query(
            IndexName="influencer-main-index",
            KeyConditionExpression="id_influencer_main = :m",
            ExpressionAttributeValues={":m": id_influencer_main},
        )
        for item in q.get("Items", []):
            pid = item.get("id_influencer")
            if pid and str(pid) not in candidate_ids:
                candidate_ids.append(str(pid))
    except ClientError as e:
        logger.info("uppy_influencer GSI query skipped or failed: %s", e)
    return candidate_ids


def _enrollment_for_campaign_and_user(campaign_id, id_influencer_main):
    enrollment_table = dynamodb.Table(ENROLLMENT_TABLE)
    try:
        r = enrollment_table.get_item(
            Key={"id_campaign": campaign_id, "id_influencer": id_influencer_main}
        )
        if r.get("Item"):
            return r["Item"], id_influencer_main
    except ClientError:
        raise

    candidate_ids = _resolve_candidate_influencer_ids(id_influencer_main)
    for pid in candidate_ids[1:]:
        try:
            r = enrollment_table.get_item(
                Key={"id_campaign": campaign_id, "id_influencer": pid}
            )
            if r.get("Item"):
                return r["Item"], pid
        except ClientError:
            raise
    return None, None


def _batch_get_items(table_name, keys):
    """keys: list of key dicts for DynamoDB BatchGetItem. Returns list of items."""
    if not keys:
        return []
    client = dynamodb.meta.client
    items = []
    idx = 0
    while idx < len(keys):
        chunk = keys[idx : idx + 100]
        idx += 100
        request_items = {table_name: {"Keys": chunk}}
        unprocessed_retries = 0
        while request_items:
            resp = client.batch_get_item(RequestItems=request_items)
            items.extend(resp.get("Responses", {}).get(table_name, []))
            request_items = resp.get("UnprocessedKeys") or {}
            if request_items:
                unprocessed_retries += 1
                if unprocessed_retries > 5:
                    logger.warning(
                        "batch_get_item %s: giving up on UnprocessedKeys",
                        table_name,
                    )
                    break
    return items


def _fetch_campaign_extras_by_ids(campaign_ids):
    """
    Load campaign_name and invoice_id from uppy_campaigns, then billing_country from
    uppy_invoice, and derive currency (e.g. United States -> USD).

    Returns:
        dict id_campaign (str) -> {"campaign_name": str|None, "currency": str}
    """
    unique = []
    seen = set()
    for cid in campaign_ids:
        if not cid:
            continue
        s = str(cid)
        if s not in seen:
            seen.add(s)
            unique.append(s)

    out = {cid: {"campaign_name": None, "currency": "-"} for cid in unique}
    if not unique:
        return out

    camp_keys = [{"id_campaign": k} for k in unique]
    campaign_items = _batch_get_items(CAMPAIGNS_TABLE_NAME, camp_keys)

    by_campaign = {}
    invoice_ids_needed = []
    inv_seen = set()
    for item in campaign_items:
        k = item.get("id_campaign")
        if k is None:
            continue
        sk = str(k)
        by_campaign[sk] = item
        inv_id = item.get("invoice_id")
        if inv_id is not None and str(inv_id).strip():
            sid = str(inv_id).strip()
            if sid not in inv_seen:
                inv_seen.add(sid)
                invoice_ids_needed.append(sid)

    inv_keys = [{"invoice_id": iid} for iid in invoice_ids_needed]
    invoice_items = _batch_get_items(INVOICE_TABLE_NAME, inv_keys)
    by_invoice = {}
    for item in invoice_items:
        iid = item.get("invoice_id")
        if iid is not None:
            by_invoice[str(iid)] = item

    for cid in unique:
        row = by_campaign.get(cid)
        if not row:
            continue
        name = row.get("campaign_name")
        out[cid]["campaign_name"] = name
        inv_id = row.get("invoice_id")
        if inv_id is None or not str(inv_id).strip():
            continue
        inv_row = by_invoice.get(str(inv_id).strip())
        if not inv_row:
            continue
        country = inv_row.get("billing_country")
        out[cid]["currency"] = _currency_from_billing_country(country)

    return out


def _list_enrollments_for_candidates(candidate_ids):
    """
    All enrollment rows for any of the given id_influencer values.
    Deduplicates by (id_campaign, id_influencer).
    """
    if not candidate_ids:
        return []
    table = dynamodb.Table(ENROLLMENT_TABLE)
    items = []
    if ENROLLMENT_INFLUENCER_GSI_NAME:
        for pid in candidate_ids:
            exclusive_start_key = None
            while True:
                kwargs = {
                    "IndexName": ENROLLMENT_INFLUENCER_GSI_NAME,
                    "KeyConditionExpression": "id_influencer = :p",
                    "ExpressionAttributeValues": {":p": pid},
                }
                if exclusive_start_key:
                    kwargs["ExclusiveStartKey"] = exclusive_start_key
                resp = table.query(**kwargs)
                items.extend(resp.get("Items", []))
                exclusive_start_key = resp.get("LastEvaluatedKey")
                if not exclusive_start_key:
                    break
    else:
        placeholders = []
        expr_values = {}
        for i, pid in enumerate(candidate_ids):
            ph = f":p{i}"
            placeholders.append(ph)
            expr_values[ph] = pid
        filt = "id_influencer IN (" + ", ".join(placeholders) + ")"
        exclusive_start_key = None
        while True:
            kwargs = {
                "FilterExpression": filt,
                "ExpressionAttributeValues": expr_values,
            }
            if exclusive_start_key:
                kwargs["ExclusiveStartKey"] = exclusive_start_key
            resp = table.scan(**kwargs)
            items.extend(resp.get("Items", []))
            exclusive_start_key = resp.get("LastEvaluatedKey")
            if not exclusive_start_key:
                break

    seen = set()
    out = []
    for it in items:
        key = (it.get("id_campaign"), it.get("id_influencer"))
        if not key[0] or key in seen:
            continue
        seen.add(key)
        out.append(it)
    return out


def _load_message_from_s3(s3_key):
    """
    Load step UI message JSON from S3 (same bucket/key layout as create_flow / get_flow).
    Returns parsed dict or None on missing key or error.
    """
    if not s3_key or not isinstance(s3_key, str) or not s3_key.strip():
        return None
    key = s3_key.strip()
    try:
        response = s3_client.get_object(Bucket=CAMPAIGN_MESSAGES_BUCKET, Key=key)
        body = response["Body"].read().decode("utf-8")
        return json.loads(body)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code == "NoSuchKey":
            logger.warning("Step message not found in S3: %s", key)
        else:
            logger.error("S3 get_object failed for %s: %s", key, e)
        return None
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        logger.error("Invalid message JSON in S3 %s: %s", key, e)
        return None
    except Exception as e:
        logger.error("Error loading message from S3 %s: %s", key, e)
        return None


def _text_from_step_s3_message(ui_message):
    """Extract display text from S3 message object (create_flow stores under `text`)."""
    if not isinstance(ui_message, dict):
        return None
    t = ui_message.get("text")
    if t is None:
        return None
    if isinstance(t, str):
        return t
    return str(t)


def _negotiated_amount_display(enrollment):
    """
    Enrollment may store negotiatedAmount (camelCase) or negotiated_amount.
    Missing or empty -> "-" for API consumers.
    """
    if not enrollment:
        return "-"
    val = enrollment.get("negotiatedAmount")
    if val is None:
        val = enrollment.get("negotiated_amount")
    if val is None or val == "":
        return "-"
    return val


def _build_single_campaign_body(flow_item, enrollment):
    steps = flow_item.get("steps") or []
    if not isinstance(steps, list):
        steps = []

    resolved_influencer_id = enrollment.get("id_influencer")
    current_step_id = enrollment.get("current_step_id")
    if not current_step_id:
        return None, {
            "error": "Unprocessable entity",
            "message": "Enrollment has no current_step_id",
            "enrollment_id": enrollment.get("enrollment_id"),
            "id_campaign": enrollment.get("id_campaign"),
            "negotiated_amount": _negotiated_amount_display(enrollment),
        }

    canonical = _canonical_path_step_ids(steps)
    completed_ids = _completed_step_ids_from_path(canonical, current_step_id)
    completion_mode = "path"
    if not completed_ids and canonical and current_step_id not in canonical:
        completed_ids = _fallback_completed_by_order(steps, current_step_id)
        completion_mode = "order_fallback"

    completed_set = set(completed_ids)

    unique_keys = []
    seen_k = set()
    for s in sorted(steps, key=lambda x: x.get("order", 0)):
        k = s.get("ui_message_s3_key")
        if not k or not isinstance(k, str) or not k.strip():
            continue
        kn = k.strip()
        if kn not in seen_k:
            seen_k.add(kn)
            unique_keys.append(kn)
    messages_by_key = {k: _load_message_from_s3(k) for k in unique_keys}

    step_payloads = []
    for s in sorted(steps, key=lambda x: x.get("order", 0)):
        sid = s.get("step_id")
        if not sid:
            continue
        s3_key = s.get("ui_message_s3_key")
        s3_key_norm = s3_key.strip() if isinstance(s3_key, str) else None
        ui_msg = messages_by_key.get(s3_key_norm) if s3_key_norm else None
        step_payloads.append(
            {
                "step_id": sid,
                "name": s.get("name"),
                "order": s.get("order"),
                "step_type": s.get("step_type"),
                "text": _text_from_step_s3_message(ui_msg),
                "completed": sid in completed_set,
                "is_current": sid == current_step_id,
            }
        )

    body = {
        "id_campaign": enrollment.get("id_campaign"),
        "id_influencer": resolved_influencer_id,
        "enrollment_id": enrollment.get("enrollment_id"),
        "negotiated_amount": _negotiated_amount_display(enrollment),
        "current_step_id": current_step_id,
        "completed_step_ids": completed_ids,
        "completed_count": len(completed_ids),
        "total_steps": len(step_payloads),
        "completion_mode": completion_mode,
        "steps": step_payloads,
    }
    return body, None


def lambda_handler(event, context):
    try:
        logger.info("get_campaign_step_progress invoked")

        influencer_id = _extract_influencer_id_from_verified_identity(event)
        if not influencer_id:
            return _response(
                401,
                {
                    "error": "Unauthorized",
                    "message": (
                        "Could not resolve influencer id for this user. "
                        "Use Authorization: Bearer with a valid Cognito token; "
                        f"ensure {CUSTOM_INFLUENCER_ID_KEY} is available (JWT or GetUser)."
                    ),
                },
            )

        flow_table = dynamodb.Table(CAMPAIGN_FLOW_TABLE)
        campaign_id = _extract_campaign_id(event)

        if not campaign_id:
            candidate_ids = _resolve_candidate_influencer_ids(influencer_id)
            enrollments = _list_enrollments_for_candidates(candidate_ids)
            campaign_ids_for_names = [
                e.get("id_campaign") for e in enrollments if e.get("id_campaign")
            ]
            extras_by_campaign = _fetch_campaign_extras_by_ids(campaign_ids_for_names)
            campaigns_payload = []
            for enr in enrollments:
                cid = enr.get("id_campaign")
                if not cid:
                    continue
                extra = extras_by_campaign.get(
                    str(cid), {"campaign_name": None, "currency": "-"}
                )
                cname = extra["campaign_name"]
                currency = extra["currency"]
                flow_resp = flow_table.get_item(Key={"id_campaign": cid})
                flow_item = flow_resp.get("Item")
                if not flow_item:
                    campaigns_payload.append(
                        {
                            "id_campaign": cid,
                            "campaign_name": cname,
                            "currency": currency,
                            "id_influencer": enr.get("id_influencer"),
                            "enrollment_id": enr.get("enrollment_id"),
                            "negotiated_amount": _negotiated_amount_display(enr),
                            "error": "Not found",
                            "message": "Campaign flow not found for this campaign",
                        }
                    )
                    continue
                body, err = _build_single_campaign_body(flow_item, enr)
                if err:
                    entry = {
                        "id_campaign": cid,
                        "campaign_name": cname,
                        "currency": currency,
                        "id_influencer": enr.get("id_influencer"),
                        "enrollment_id": enr.get("enrollment_id"),
                    }
                    entry.update(err)
                    campaigns_payload.append(entry)
                else:
                    body["campaign_name"] = cname
                    body["currency"] = currency
                    campaigns_payload.append(body)

            return _response(
                200,
                {
                    "id_influencer_main": influencer_id,
                    "campaign_count": len(campaigns_payload),
                    "campaigns": campaigns_payload,
                },
            )

        extras_by_campaign = _fetch_campaign_extras_by_ids([campaign_id])
        extra = extras_by_campaign.get(
            str(campaign_id), {"campaign_name": None, "currency": "-"}
        )
        campaign_name = extra["campaign_name"]
        currency = extra["currency"]

        flow_resp = flow_table.get_item(Key={"id_campaign": campaign_id})
        flow_item = flow_resp.get("Item")
        if not flow_item:
            return _response(
                404,
                {
                    "error": "Not found",
                    "message": "Campaign flow not found for this campaign",
                    "id_campaign": campaign_id,
                    "campaign_name": campaign_name,
                    "currency": currency,
                    "negotiated_amount": "-",
                },
            )

        enrollment, resolved_influencer_id = _enrollment_for_campaign_and_user(
            campaign_id, influencer_id
        )
        if not enrollment:
            return _response(
                404,
                {
                    "error": "Not found",
                    "message": "No enrollment for this influencer and campaign",
                    "id_campaign": campaign_id,
                    "campaign_name": campaign_name,
                    "currency": currency,
                    "negotiated_amount": "-",
                },
            )

        body, err = _build_single_campaign_body(flow_item, enrollment)
        if err:
            return _response(
                422,
                {
                    **err,
                    "id_influencer": resolved_influencer_id,
                    "campaign_name": campaign_name,
                    "currency": currency,
                },
            )

        body["id_influencer"] = resolved_influencer_id
        body["campaign_name"] = campaign_name
        body["currency"] = currency
        return _response(200, body)

    except ClientError:
        logger.exception("DynamoDB error")
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
