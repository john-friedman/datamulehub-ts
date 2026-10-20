# Datamule Hub for TypeScript

TypeScript port of the Python `datamulehub` package. Same namespaces, function names, filter names, API endpoints, and billing fields. Uses streaming I/O, with local file output in Node.js and storage callbacks in Cloudflare Workers.

## Build

Requires Node.js 22 or later.

```sh
npm install
npm run build
npm run typecheck
npm run check:worker
```

`check:worker` bundles the complete library for a browser/Worker target and checks that Node-only dependencies stay out. There is no test suite. These checks do not call paid services or deploy anything.

## Calls

Python keyword arguments become an options object. Required arguments such as SQL or dataset names stay positional. Network operations use `await`; streams use `for await`.

```ts
import { databases, datasets, sec_filings_archive, sec_filings_lookup,
  sec_filings_notifications, object_transfer } from 'datamulehub-ts';

const filings = await sec_filings_lookup.lookup_sgml({
  ticker: 'MSFT',
  submission_type: ['8-K', '8-K/A'],
  filing_date: ['2026-01-01', '2026-10-01'],
});

for await (const page of sec_filings_lookup.stream_tar({
  cik: 789019,
  document_type: '8-K',
})) {
  console.log(page.accession, page.filename, page.start, page.end);
}

await sec_filings_archive.download_tar({
  ticker: 'MSFT',
  submission_type: ['8-K', '8-K/A'],
  output_dir: 'downloads/msft',
});

await datasets.download('345', {
  filename: 'downloads/345.parquet',
  from_storage: 'both',
});

const rows = await databases.read_query('SELECT * FROM fastest_sec_filings_metadata LIMIT 10');
```

In Node, set `DATAMULE_API_KEY` or pass `api_key` to each call. In Workers, pass the secret from `env.DATAMULE_API_KEY`. No global client configuration is needed. The package is ESM.

## Public API

| Namespace | Functions |
| --- | --- |
| `sec_filings_lookup` | `lookup_sgml`, `lookup_tar`, `stream_sgml`, `stream_tar` |
| `sec_filings_archive` | `download_sgml`, `download_tar`, `download_xbrl` |
| `datasets` | `resolve_path`, `get_link`, `download` |
| `databases` | `query`, `read_query` |
| `sec_filings_notifications` | `add_endpoint`, `list_endpoints`, `remove_endpoint`, `stream_filings`, `stream_fastest_filings` |
| `object_transfer` | `transfer_sgml_archive_s3`, `transfer_tar_archive_s3`, `transfer_xbrl_archive_s3`, `transfer_dataset_s3`, and the corresponding `_gcs` functions |
| `utils` | `format_accession`, `detect_accession_type`, `normalize_accessions`, `resolve_cik_filter` |

Subpath imports such as `datamulehub-ts/sec_filings_lookup` are also available.

Filings filters: `cik`, `ticker`, `accession`, `submission_type`, `filing_date`, `report_date`, `detected_time`, `contains_xbrl`, `document_type`, `filename`, `sequence`, `page`, and `page_size`. `ticker` and `cik` are mutually exclusive. Lookup functions return column arrays; `stream_*` lookup functions yield one page at a time. Omitting `page` fetches all pages; specifying it fetches only that page. The default page size is 25,000.

Common request options: `api_key`, `signal`, `timeout` in seconds, `fetch`, and `base_url`. `base_url` overrides the API origin; archive downloads additionally accept `sgml_base_url` and `tar_base_url`. Timeouts apply to response consumption as well as connection establishment. Calls throw on HTTP or API errors. Requests are not retried automatically except notification reconnects, delta-file 404 retries, and explicit transfer retries.

## Downloads and Workers

Downloads default to local files in Node. Local writes use a temporary sibling file and rename it after success. Archive downloads default to `downloads/batch_000001.tar`, rotating near `tar_max_size_mb` (512 by default). A single entry can exceed the shard target. Set `tar_max_size_mb: null` for individual files. Returned paths identify output shards/files once each.

Archive options also include `decompress` (default `true`), `overwrite` (default `false`), `max_workers` (default `4`), and `max_buffer_bytes` (default 32 MiB). Whole TAR downloads extract members; document filters fetch exact byte ranges. `document_type: 'metadata'` downloads only `metadata.json`. XBRL objects missing from storage are skipped.

Workers supplies output through `write_file(path, body)`. The callback must consume the entire `ReadableStream<Uint8Array>` and await storage completion. It must reject on a failed write. The library supplies an R2 writer with multipart uploads and cleanup:

```ts
import { r2_writer, sec_filings_archive } from 'datamulehub-ts';

const files = await sec_filings_archive.download_tar({
  api_key: env.DATAMULE_API_KEY,
  cik: 789019,
  document_type: '8-K',
  page: 1,
  page_size: 10,
  output_dir: 'msft', // R2 object prefix
  tar_max_size_mb: null,
  max_workers: 2,
  write_file: r2_writer(env.FILINGS),
});
```

Use the same callback on `datasets.download()` and `databases.query()`. R2 multipart uploads buffer 8 MiB per part by default; `r2_writer(bucket, { chunk_size_mb, max_buffer_bytes, signal })` controls that. It also handles small and empty objects. A raw `bucket.put(path, body)` callback is insufficient for arbitrary transformed streams because R2 requires a known-length body.

See [examples/worker.ts](examples/worker.ts). It demonstrates a bounded lookup and a small archive request; connect your own R2 binding and API secret. Large archive jobs should run as batches under a Queue or Workflow, rather than depend on an HTTP client remaining connected. The SDK does not create Cloudflare infrastructure.

## Datasets and SQL

`datasets.download(name, options)` preserves `from_storage: 'daily' | 'delta' | 'both'` (`both` by default). XML, filing metadata, and simple XBRL datasets use the same Eastern-time delta window as Python. Snapshot source keys are removed from the candidate set before merging. `accession: ['0000789019-26-000123']` selects per-filing files; results include `missing_accessions`.

Daily-only downloads stream unchanged. Merges read Parquet by byte range, retain source schemas, reject incompatible types, add `_sourceKey`, and write Snappy-compressed row groups. Python writes Zstandard; this changes compression, not the table contents. Link and download billing fields are retained. Merging requires storage that supports HTTP byte ranges.

`databases.query(sql, { output_dir, ... })` streams result files to `part-00000.parquet`, `part-00001.parquet`, etc. It preserves query IDs and billing headers. `wait_seconds` defaults to 600; `null` omits that server option. The `fastest_sec_filings_metadata` SQL subset retains Python's filter restrictions and uses the JSON endpoint.

`databases.read_query(sql, { max_rows, ... })` returns row objects. It necessarily collects all returned rows. Add a SQL limit or `max_rows` for interactive use. In Node, its input files spool to temporary disk; in Workers, each result file must fit `max_buffer_bytes`. Use `query()` when you only need to transfer large result files.

Parquet input decoding is by row group, not by entire dataset. `max_buffer_bytes` limits each input range, the estimated uncompressed input group, and encoded output groups. JavaScript objects and decoder windows add overhead, so this is not a total-process memory cap. `row_group_size` controls output rows buffered at once (default 4096). Large source row groups may require processing outside Workers or an explicitly larger budget in Node. Input codecs supported here are uncompressed, Snappy, and Zstandard. Legacy INT96 timestamp merging is rejected. Daily file downloads do not decode or alter any codec.

## Notifications

```ts
await sec_filings_notifications.add_endpoint({
  endpoint: 'https://example.com/sec-filings',
  submission_types: ['8-K'],
  ciks: [789019],
  sources: ['Rss', 'Efts'],
});

const endpoints = await sec_filings_notifications.list_endpoints();
await sec_filings_notifications.remove_endpoint({ id: 'endpoint-id' });

const controller = new AbortController();
for await (const filing of sec_filings_notifications.stream_filings({
  signal: controller.signal,
})) {
  console.log(filing);
}
```

Your webhook receiver must process SNS subscription confirmation before receiving notifications. Registration alone does not implement a receiver.

Node uses `ws` for authenticated connections; Workers uses its HTTP Upgrade API. Streams reconnect on transport failures and stop on authentication/application errors, cancellation, or queue overflow. `max_queue` defaults to 1024 filing events. `stream_fastest_filings()` purchases a service token, reuses it on reconnect, and obtains another only when expired. This is chargeable API behavior, as in Python. Keep a single intended subscription alive rather than starting one per incoming request.

Options retain `idle_timeout`, `ping_interval`, `ping_timeout`, `recv_timeout`, and `reconnect_delay`. Node supports raw ping/pong checks. Workers handles protocol ping/pong internally and does not expose those controls; application idle detection remains active. `recv_timeout` is accepted for compatibility; the implementation is event-driven and has no blocking receive timeout. A custom `connect` adapter can be supplied if needed.

## S3 and GCS transfers

```ts
await object_transfer.transfer_tar_archive_s3({
  s3_credentials: {
    aws_access_key_id: '...',
    aws_secret_access_key: '...',
    region_name: 'us-east-1',
    bucket_name: 'my-bucket',
  },
  cik: 320193,
  submission_type: '10-K',
  filing_date: ['2020-01-01', '2024-01-01'],
  prefix: 'sec-filings',
});

await object_transfer.transfer_dataset_gcs({
  datasets: ['xml2tables/345'],
  gcs_credentials: {
    bucket_name: 'my-bucket',
    service_file: 'service_account.json', // Node only
  },
});
```

Archive transfers copy stored objects without decompressing them. Document filters select whole matching filings. Dataset transfers copy the stored daily object, matching Python. S3 uses signed requests and multipart uploads; GCS uses resumable uploads. Failed uploads are aborted. Defaults: `max_workers: 4`, `retry_errors: 3`, `chunk_size_mb: 8`. Known large S3 objects automatically use larger parts to stay within 10,000 parts, subject to `max_buffer_bytes`.

S3 credentials also support `aws_session_token` and `endpoint_url` for S3-compatible storage. GCS accepts a `service_account` object, an `access_token` string, or an async token provider. In Node it can read `service_file`, `GOOGLE_APPLICATION_CREDENTIALS`, or the local gcloud ADC file (service-account/authorized-user credentials). Metadata-server and workload-identity discovery are not implemented. In Workers, pass credentials or a token provider explicitly.

Transfer functions return `{ total, successful, size_bytes, failed }`. Failed items are also written to `errors_archive_transfer.json` or `errors_datasets_transfer.json` in Node; override `errors_json_filename` or set it to `null`. Workers returns failures and only writes an error file if you provide `write_file`. `on_progress` receives counts and bytes without a terminal progress dependency. Credentials and options can also be passed as separate positional arguments.

## Differences from Python

- Options are objects, calls are asynchronous, and `None` becomes `null` only where meaningful. Omit optional fields instead of passing `None`.
- Date/time ranges accept two-item arrays or `{ start, end }`. JavaScript cannot distinguish a Python tuple range from a list of discrete dates; arrays in date/time filters mean ranges.
- Pass accession numbers as strings or `bigint`. Unsafe numeric inputs are rejected. Unsafe integers in JSON responses are preserved as strings before rounding. `format_accession(value, 'int')` returns an unpadded decimal string.
- Parquet 64-bit integer columns return `bigint`. For JSON output, use a replacer such as `JSON.stringify(rows, (_, value) => typeof value === 'bigint' ? value.toString() : value)`.
- `max_workers` defaults to 4 instead of 100. Node archive batching overlaps downloads using temporary disk. Workers shard output processes one entry at a time to limit memory; individual-file output remains concurrent. `decomp_workers` is accepted and validated, but does not create native CPU threads.
- Zstandard decoding uses `fzstd`, a small JavaScript dependency. It supports backreference windows up to 32 MiB; larger windows require a different decoder. No native executable or WASM build is required.
- `overwrite: true` replaces matching local files without deleting unrelated files in the output directory. With a storage callback, existence/overwrite policy belongs to your storage implementation.
- Download failures throw instead of silently continuing after archive errors. Partial local files are removed; completed files and earlier completed shards remain available.
- `chunk_size` remains accepted on dataset/database calls; fetch controls network chunking. Use `chunk_size_mb` for transfer buffers.
- Progress bars and global logging configuration are omitted.

Runtime dependencies: `fzstd`, `hyparquet`, `hyparquet-writer`, `lossless-json`, `aws4fetch`, and Node-only `ws`. Worker bundles exclude Node-only code. Build tools are development dependencies.
