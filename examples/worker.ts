import { r2_writer, sec_filings_archive, sec_filings_lookup } from '../src/index.js';
import type { R2BucketLike } from '../src/object_transfer.js';

interface Env {
  DATAMULE_API_KEY: string;
  FILINGS: R2BucketLike;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const common = {
      api_key: env.DATAMULE_API_KEY,
      ticker: url.searchParams.get('ticker') ?? 'MSFT',
      submission_type: '8-K',
      page: 1,
      page_size: 10,
      signal: request.signal,
    };
    if (url.pathname === '/archive' && request.method === 'POST') {
      const files = await sec_filings_archive.download_tar({
        ...common,
        output_dir: 'filings',
        tar_max_size_mb: null,
        max_workers: 2,
        write_file: r2_writer(env.FILINGS, { signal: request.signal }),
      });
      return Response.json({ files });
    }
    return Response.json(await sec_filings_lookup.lookup_sgml(common));
  },
};
