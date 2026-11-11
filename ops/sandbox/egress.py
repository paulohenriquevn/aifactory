"""The egress policy of one sandbox, for mitmproxy.

Reads /rules/rules.json, `{"allow": {"github.com": {"headers": {"authorization": "..."}}, "*.npmjs.org": {}}}`.
A request to a host that is not listed is refused, and a listed host gets its headers attached outside the
sandbox, so a credential never exists inside it. There is no catch-all entry.

The factory replaces the file while the sandbox runs, to renew a credential before it expires, so the file is
read again whenever it changes. The factory renames a complete file over the old one, so a read never sees
half of it. A file that cannot be read keeps the rules already loaded: the policy never opens up.
"""
import json
import os
import sys

from mitmproxy import http

RULES = os.environ.get("FACTORY_EGRESS_RULES", "/rules/rules.json")


def read_rules():
    with open(RULES) as f:
        return json.load(f)["allow"]


ALLOW = read_rules()
LOADED = os.stat(RULES).st_mtime_ns


def current():
    global ALLOW, LOADED
    try:
        changed = os.stat(RULES).st_mtime_ns
        if changed != LOADED:
            ALLOW, LOADED = read_rules(), changed
    except (OSError, ValueError, KeyError) as error:
        print(f"egress: keeping the rules loaded before; {RULES} could not be read: {error}", file=sys.stderr)
    return ALLOW


def rule_for(host):
    allow = current()
    host = (host or "").lower().rstrip(".")
    if host in allow:
        return allow[host]
    for pattern, rule in allow.items():
        if pattern.startswith("*.") and host.endswith(pattern[1:]):
            return rule
    return None


def refuse(flow):
    flow.response = http.Response.make(
        403, b"blocked by the factory egress policy", {"content-type": "text/plain"}
    )


def http_connect(flow: http.HTTPFlow):
    if rule_for(flow.request.host) is None:
        refuse(flow)


def request(flow: http.HTTPFlow):
    rule = rule_for(flow.request.pretty_host)
    if rule is None:
        refuse(flow)
        return
    for name, value in (rule.get("headers") or {}).items():
        flow.request.headers[name] = value
