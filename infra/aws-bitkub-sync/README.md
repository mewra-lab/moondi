# AWS Bitkub sync Lambda

This is the production successor to the diagnostic Lambda POC. It retrieves
read-only Bitkub balances, order history, and crypto/fiat transfer history from
AWS, then sends bounded normalized records to Moondi's API. It has no public
HTTP endpoint and uses only the Python runtime's standard library plus Lambda's
built-in `boto3`.

The production setup is intentionally manual because it creates credentials in
the owner's AWS and Cloudflare accounts. Follow [the deployment guide](../../docs/deployment.md#aws-bitkub-secure-sync) in order. Do not copy the POC's
CloudWatch logs, API key, secret, Cloudflare service-token secret, or ingestion
secret into this repository.

The Lambda handler is `lambda_function.lambda_handler`.

Order history is discovered from every active `source=exchange` symbol returned
by Bitkub, including non-THB pairs such as `BTC_USDT`. Keyset pagination is
followed to completion. All history types are streamed to the API in bounded
chunks; only the final accepted chunk advances that data type's checkpoint, so
a retry cannot silently skip a partially delivered history window.
