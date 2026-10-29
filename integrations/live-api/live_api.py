"""
LIVE API client (docs section 3: General API request method)

Flow (per docs):
 1. request params -> JSON string
 2. params    = Base64( AES/ECB/PKCS5Padding(json, AES_KEY) )
 3. signature = MD5(json + MD5_KEY)  (uppercase hex)
 4. POST {merchantCode, params, signature} as JSON to  API_ROOT + method + "/v1"
 5. Timeout: 30 seconds

Env vars needed:
    LIVE_MERCHANT_CODE, LIVE_AES_KEY, LIVE_MD5_KEY, LIVE_API_ROOT
    (API_ROOT must end with "/", e.g. https://xxxx/api/)

Install:  pip install pycryptodome requests
"""
import base64
import hashlib
import json
import os
import time

import requests
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad

MERCHANT_CODE = os.environ.get("LIVE_MERCHANT_CODE", "")
AES_KEY = os.environ.get("LIVE_AES_KEY", "")
MD5_KEY = os.environ.get("LIVE_MD5_KEY", "")
API_ROOT = os.environ.get("LIVE_API_ROOT", "")
TIMEOUT = 30  # docs 3.5: set timeout to 30 seconds


def _to_json(obj: dict) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def encrypt_params(json_str: str) -> str:
    cipher = AES.new(AES_KEY.encode("utf-8"), AES.MODE_ECB)
    enc = cipher.encrypt(pad(json_str.encode("utf-8"), AES.block_size))
    return base64.b64encode(enc).decode("utf-8")


def decrypt_params(b64: str) -> str:
    cipher = AES.new(AES_KEY.encode("utf-8"), AES.MODE_ECB)
    raw = unpad(cipher.decrypt(base64.b64decode(b64)), AES.block_size)
    return raw.decode("utf-8")


def sign(json_str: str) -> str:
    return hashlib.md5((json_str + MD5_KEY).encode("utf-8")).hexdigest().upper()


def submit(method: str, params: dict) -> dict:
    """Equivalent of the Java submit(method, object)."""
    source = _to_json(params)
    body = {
        "merchantCode": MERCHANT_CODE,
        "params": encrypt_params(source),
        "signature": sign(source),
    }
    url = API_ROOT + method + "/v1"
    resp = requests.post(url, json=body, timeout=TIMEOUT)
    resp.raise_for_status()
    result = resp.json()

    # code "200" = success, anything else is a failure (e.g. "90000" Parameter error)
    # Some interfaces return encrypted data; decrypt if it is a string.
    data = result.get("data")
    if isinstance(data, str):
        try:
            result["data"] = json.loads(decrypt_params(data))
        except Exception:
            pass  # not encrypted, keep as is
    return result


def _ts() -> int:
    return int(time.time() * 1000)


# ---- Examples from docs ----
def create_player(login_name: str, password: str = "abc123456"):
    return submit("create", {
        "loginName": login_name,
        "loginPassword": password,
        "oddType": 4333,
        "lang": 1,
        "timestamp": _ts(),
    })


def get_balance(login_name: str):
    return submit("balance", {
        "loginName": login_name,
        "timestamp": _ts(),
    })


if __name__ == "__main__":
    print(create_player("j716testuser"))
    print(get_balance("j716testuser"))
