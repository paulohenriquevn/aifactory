"""The egress policy of one sandbox, for mitmproxy.

Reads /rules/rules.json, `{"allow": {"github.com": {"headers": {"authorization": "..."}}, "*.npmjs.org": {}}}`.
A request to a host that is not listed is refused, and a listed host gets its headers attached outside the
sandbox, so a credential never exists inside it. There is no catch-all entry.
"""
import json

from mitmproxy import http

ALLOW = json.load(open("/rules/rules.json"))["allow"]


def rule_for(host):
    host = (host or "").lower().rstrip(".")
    if host in ALLOW:
        return ALLOW[host]
    for pattern, rule in ALLOW.items():
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
