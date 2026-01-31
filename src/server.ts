import express, { type Application, type Request, type Response } from 'express';
import cors from 'cors';
import path from 'node:path';
import Loki, { type Collection } from 'lokijs';
import { fileURLToPath } from 'node:url';
import { PDFParse } from 'pdf-parse';

import type {
  Paper,
  PaperInput,
  PaperUpdateInput,
  PaperMetadata,
  ApiResponse,
  PaperQuery,
  LokiPaper,
  SSEClient,
} from './types/index.js';

// ES Module dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app: Application = express();
const PORT = process.env['PORT'] ?? 3000;

// Track SSE clients for real-time updates
const sseClients = new Set<SSEClient>();

// Broadcast update to all connected SSE clients
function broadcast(event: string, data: unknown): void {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((res) => {
    res.write(message);
  });
}

// Initialize LokiJS database
let papers: Collection<LokiPaper>;

// Determine data path based on environment
const dataPath = process.env['NODE_ENV'] === 'production'
  ? path.join(__dirname, '..', 'data', 'papers.db')
  : path.join(__dirname, '..', 'data', 'papers.db');

const db = new Loki(dataPath, {
  autoload: true,
  autoloadCallback: initializeDatabase,
  autosave: true,
  autosaveInterval: 4000,
});

function initializeDatabase(): void {
  // Get or create the papers collection
  let collection = db.getCollection<LokiPaper>('papers');
  if (!collection) {
    collection = db.addCollection<LokiPaper>('papers', {
      unique: ['url'],
      indices: ['dateAdded', 'title'],
    });
  }
  papers = collection;
  console.log('📁 Database initialized');
}

// Generate unique ID
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 11);
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

// ============== SSE ENDPOINT ==============

// Server-Sent Events endpoint for real-time updates (Cloudflare friendly)
app.get('/api/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ clientCount: sseClients.size + 1 })}\n\n`);

  sseClients.add(res);
  console.log(`📱 SSE client connected. Total: ${sseClients.size}`);

  // Send keepalive every 30 seconds to prevent timeout
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
    console.log(`📱 SSE client disconnected. Total: ${sseClients.size}`);
  });
});

// ============== API ROUTES ==============

// GET all papers
app.get('/api/papers', (req: Request<unknown, unknown, unknown, PaperQuery>, res: Response<ApiResponse<Paper[]>>) => {
  try {
    const { search, tag, sort = 'dateAdded', order = 'desc' } = req.query;

    let results = papers.chain();

    // Search filter
    if (search) {
      const searchLower = search.toLowerCase();
      results = results.where((paper: LokiPaper) => {
        return (
          (paper.title?.toLowerCase().includes(searchLower)) ||
          (paper.authors?.toLowerCase().includes(searchLower)) ||
          (paper.abstract?.toLowerCase().includes(searchLower)) ||
          (paper.tags?.some((t) => t.toLowerCase().includes(searchLower)))
        );
      });
    }

    // Tag filter
    if (tag) {
      results = results.where((paper: LokiPaper) => paper.tags?.includes(tag));
    }

    // Sort
    const isDescending = order === 'desc';
    results = results.simplesort(sort as keyof LokiPaper, { desc: isDescending });

    // Map to clean response (remove LokiJS metadata)
    const data = results.data().map(cleanPaper);

    res.json({ success: true, data });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ success: false, error: errorMessage });
  }
});

// GET single paper by ID
app.get('/api/papers/:id', (req: Request<{ id: string }>, res: Response<ApiResponse<Paper>>) => {
  try {
    const paper = papers.findOne({ _id: req.params.id });

    if (!paper) {
      res.status(404).json({ success: false, error: 'Paper not found' });
      return;
    }

    res.json({ success: true, data: cleanPaper(paper) });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ success: false, error: errorMessage });
  }
});

// POST new paper
app.post('/api/papers', (req: Request<unknown, unknown, PaperInput>, res: Response<ApiResponse<Paper>>) => {
  try {
    const { url, title, authors, abstract, tags, source } = req.body;

    if (!url) {
      res.status(400).json({ success: false, error: 'URL is required' });
      return;
    }

    // Check if paper already exists
    const existing = papers.findOne({ url });
    if (existing) {
      res.status(409).json({ success: false, error: 'Paper already exists', data: cleanPaper(existing) });
      return;
    }

    const paper: LokiPaper = {
      _id: generateId(),
      url,
      title: title ?? 'Untitled Paper',
      authors: authors ?? '',
      abstract: abstract ?? '',
      tags: tags ?? [],
      source: source ?? detectSource(url),
      dateAdded: new Date().toISOString(),
      lastAccessed: null,
      accessCount: 0,
    };

    const newPaper = papers.insert(paper);
    if (!newPaper) {
      res.status(500).json({ success: false, error: 'Failed to insert paper' });
      return;
    }
    const cleanedPaper = cleanPaper(newPaper);

    // Broadcast to all connected clients
    broadcast('paper:created', cleanedPaper);

    res.status(201).json({ success: true, data: cleanedPaper });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ success: false, error: errorMessage });
  }
});

// PUT update paper
app.put('/api/papers/:id', (req: Request<{ id: string }, unknown, PaperUpdateInput>, res: Response<ApiResponse<Paper>>) => {
  try {
    const { title, authors, abstract, tags, url } = req.body;

    const paper = papers.findOne({ _id: req.params.id });

    if (!paper) {
      res.status(404).json({ success: false, error: 'Paper not found' });
      return;
    }

    // Update fields
    if (title) paper.title = title;
    if (authors !== undefined) paper.authors = authors;
    if (abstract !== undefined) paper.abstract = abstract;
    if (tags) paper.tags = tags;
    if (url) {
      paper.url = url;
      paper.source = detectSource(url);
    }

    papers.update(paper);
    const cleanedPaper = cleanPaper(paper);

    // Broadcast to all connected clients
    broadcast('paper:updated', cleanedPaper);

    res.json({ success: true, data: cleanedPaper });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ success: false, error: errorMessage });
  }
});

// DELETE paper
app.delete('/api/papers/:id', (req: Request<{ id: string }>, res: Response<ApiResponse>) => {
  try {
    const paper = papers.findOne({ _id: req.params.id });

    if (!paper) {
      res.status(404).json({ success: false, error: 'Paper not found' });
      return;
    }

    papers.remove(paper);

    // Broadcast to all connected clients
    broadcast('paper:deleted', { _id: req.params.id });

    res.json({ success: true, message: 'Paper deleted successfully' });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ success: false, error: errorMessage });
  }
});

// Track paper access (when user clicks to open)
app.post('/api/papers/:id/access', (req: Request<{ id: string }>, res: Response<ApiResponse<Paper>>) => {
  try {
    const paper = papers.findOne({ _id: req.params.id });

    if (!paper) {
      res.status(404).json({ success: false, error: 'Paper not found' });
      return;
    }

    paper.lastAccessed = new Date().toISOString();
    paper.accessCount = (paper.accessCount ?? 0) + 1;
    papers.update(paper);

    res.json({ success: true, data: cleanPaper(paper) });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ success: false, error: errorMessage });
  }
});

// GET all unique tags
app.get('/api/tags', (_req: Request, res: Response<ApiResponse<string[]>>) => {
  try {
    const allPapers = papers.find();
    const tagsSet = new Set<string>();

    allPapers.forEach((paper) => {
      if (paper.tags && Array.isArray(paper.tags)) {
        paper.tags.forEach((tag) => tagsSet.add(tag));
      }
    });

    res.json({ success: true, data: Array.from(tagsSet).sort() });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ success: false, error: errorMessage });
  }
});

// Fetch paper metadata from URL (for arxiv, doi, etc.)
app.post('/api/fetch-metadata', async (req: Request<unknown, unknown, { url: string }>, res: Response<ApiResponse<PaperMetadata>>) => {
  try {
    const { url } = req.body;

    if (!url) {
      res.status(400).json({ success: false, error: 'URL is required' });
      return;
    }

    const metadata = await fetchPaperMetadata(url);
    res.json({ success: true, data: metadata });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ success: false, error: errorMessage });
  }
});

// ============== SSR EXPERIMENT ==============

app.get('/ssr', (req: Request<unknown, unknown, unknown, PaperQuery>, res: Response) => {
  try {
    const { list, tags, queryState } = getSsrData(req.query);
    const html = renderSsrApp(list, tags, queryState);
    res.status(200).send(html);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).send(`<pre>SSR error: ${errorMessage}</pre>`);
  }
});

// ============== HELPER FUNCTIONS ==============

// Remove LokiJS internal fields from response
function cleanPaper(paper: LokiPaper): Paper {
  const { $loki, meta, ...clean } = paper;
  return clean;
}

function detectSource(url: string): string {
  if (url.includes('arxiv.org')) return 'arXiv';
  if (url.includes('doi.org')) return 'DOI';
  if (url.includes('ieee.org')) return 'IEEE';
  if (url.includes('acm.org')) return 'ACM';
  if (url.includes('springer.com')) return 'Springer';
  if (url.includes('nature.com')) return 'Nature';
  if (url.includes('sciencedirect.com')) return 'ScienceDirect';
  if (url.includes('ncbi.nlm.nih.gov') || url.includes('pubmed')) return 'PubMed';
  if (url.includes('semanticscholar.org')) return 'Semantic Scholar';
  if (url.includes('openreview.net')) return 'OpenReview';
  if (url.includes('github.com')) return 'GitHub';
  return 'Web';
}

async function fetchPaperMetadata(url: string): Promise<PaperMetadata> {
  const source = detectSource(url);

  try {
    switch (source) {
      case 'arXiv':
        return await fetchArxivMetadata(url);
      case 'DOI':
        return await fetchDoiMetadata(url);
      case 'PubMed':
        return await fetchPubMedMetadata(url);
      case 'Semantic Scholar':
        return await fetchSemanticScholarMetadata(url);
      case 'OpenReview':
        return await fetchOpenReviewMetadata(url);
      case 'IEEE':
        return await fetchIEEEMetadata(url);
      case 'ACM':
        return await fetchACMMetadata(url);
      default:
        // Try generic metadata extraction for unknown sources
        return await fetchGenericMetadata(url, source);
    }
  } catch (error) {
    console.error('Error fetching metadata:', error);
    return {
      url,
      title: '',
      authors: '',
      abstract: '',
      source,
    };
  }
}

async function fetchArxivMetadata(url: string): Promise<PaperMetadata> {
  // Extract arXiv ID from URL
  const arxivIdMatch = url.match(/(?:arxiv.org\/(?:abs|pdf)\/|arxiv:)(\d+\.\d+)/i);

  if (!arxivIdMatch?.[1]) {
    return { url, title: '', authors: '', abstract: '', source: 'arXiv' };
  }

  const arxivId = arxivIdMatch[1];
  const apiUrl = `http://export.arxiv.org/api/query?id_list=${arxivId}`;

  const response = await fetch(apiUrl);
  const xmlText = await response.text();

  // Simple XML parsing for arXiv API response
  const titleMatch = xmlText.match(/<title>([\s\S]*?)<\/title>/g);
  const title = titleMatch?.[1]
    ? titleMatch[1].replace(/<\/?title>/g, '').trim().replace(/\s+/g, ' ')
    : '';

  const authorMatches = xmlText.match(/<name>([\s\S]*?)<\/name>/g);
  const authors = authorMatches
    ? authorMatches.map((a) => a.replace(/<\/?name>/g, '').trim()).join(', ')
    : '';

  const summaryMatch = xmlText.match(/<summary>([\s\S]*?)<\/summary>/);
  const abstract = summaryMatch?.[1]
    ? summaryMatch[1].trim().replace(/\s+/g, ' ')
    : '';

  return {
    url,
    title,
    authors,
    abstract,
    source: 'arXiv',
  };
}

// Fetch metadata from DOI using CrossRef API
async function fetchDoiMetadata(url: string): Promise<PaperMetadata> {
  // Extract DOI from URL
  const doiMatch = url.match(/(?:doi\.org\/|doi:)(10\.\d{4,}\/[^\s]+)/i);

  if (!doiMatch?.[1]) {
    return { url, title: '', authors: '', abstract: '', source: 'DOI' };
  }

  const doi = doiMatch[1];
  const apiUrl = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;

  const response = await fetch(apiUrl, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'PaperBookmark/1.0 (mailto:contact@example.com)',
    },
  });

  if (!response.ok) {
    return { url, title: '', authors: '', abstract: '', source: 'DOI' };
  }

  const data = await response.json() as { message?: { title?: string[]; author?: { given?: string; family?: string }[]; abstract?: string } };
  const work = data.message;

  if (!work) {
    return { url, title: '', authors: '', abstract: '', source: 'DOI' };
  }

  const title = work.title?.[0] ?? '';
  const authors = work.author
    ? work.author.map((a) =>
        [a.given, a.family].filter(Boolean).join(' ')
      ).join(', ')
    : '';
  const abstract = work.abstract
    ? work.abstract.replace(/<[^>]*>/g, '').trim()
    : '';

  return {
    url,
    title,
    authors,
    abstract,
    source: 'DOI',
  };
}

// Fetch metadata from PubMed using NCBI E-utilities
async function fetchPubMedMetadata(url: string): Promise<PaperMetadata> {
  // Extract PMID from URL
  const pmidMatch = url.match(/(?:pubmed\.ncbi\.nlm\.nih\.gov\/|pubmed\/)(\d+)/i);

  if (!pmidMatch?.[1]) {
    return { url, title: '', authors: '', abstract: '', source: 'PubMed' };
  }

  const pmid = pmidMatch[1];
  const apiUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml`;

  const response = await fetch(apiUrl);
  const xmlText = await response.text();

  // Parse XML response
  const titleMatch = xmlText.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/);
  const title = titleMatch?.[1]
    ? titleMatch[1].replace(/<[^>]*>/g, '').trim()
    : '';

  // Extract authors
  const authorMatches = xmlText.match(/<Author[\s\S]*?<\/Author>/g);
  const authors = authorMatches
    ? authorMatches.map((author) => {
        const lastName = author.match(/<LastName>([\s\S]*?)<\/LastName>/)?.[1] ?? '';
        const foreName = author.match(/<ForeName>([\s\S]*?)<\/ForeName>/)?.[1] ?? '';
        return [foreName, lastName].filter(Boolean).join(' ');
      }).join(', ')
    : '';

  const abstractMatch = xmlText.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/);
  const abstract = abstractMatch?.[1]
    ? abstractMatch[1].replace(/<[^>]*>/g, '').trim()
    : '';

  return {
    url,
    title,
    authors,
    abstract,
    source: 'PubMed',
  };
}

// Fetch metadata from Semantic Scholar API
async function fetchSemanticScholarMetadata(url: string): Promise<PaperMetadata> {
  // Extract paper ID from URL
  const paperIdMatch = url.match(/semanticscholar\.org\/paper\/(?:[^/]+\/)?([a-f0-9]+)/i);

  if (!paperIdMatch?.[1]) {
    return { url, title: '', authors: '', abstract: '', source: 'Semantic Scholar' };
  }

  const paperId = paperIdMatch[1];
  const apiUrl = `https://api.semanticscholar.org/graph/v1/paper/${paperId}?fields=title,authors,abstract`;

  const response = await fetch(apiUrl, {
    headers: {
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    return { url, title: '', authors: '', abstract: '', source: 'Semantic Scholar' };
  }

  const data = await response.json() as { title?: string; authors?: { name?: string }[]; abstract?: string };

  const title = data.title ?? '';
  const authors = data.authors
    ? data.authors.map((a: { name?: string }) => a.name).filter(Boolean).join(', ')
    : '';
  const abstract = data.abstract ?? '';

  return {
    url,
    title,
    authors,
    abstract,
    source: 'Semantic Scholar',
  };
}

// Fetch metadata from OpenReview API
async function fetchOpenReviewMetadata(url: string): Promise<PaperMetadata> {
  // Extract forum ID from URL
  const forumIdMatch = url.match(/openreview\.net\/(?:forum|pdf)\?id=([^&]+)/i);

  if (!forumIdMatch?.[1]) {
    return { url, title: '', authors: '', abstract: '', source: 'OpenReview' };
  }

  const forumId = forumIdMatch[1];
  const apiUrl = `https://api.openreview.net/notes?id=${forumId}`;

  const response = await fetch(apiUrl, {
    headers: {
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    return { url, title: '', authors: '', abstract: '', source: 'OpenReview' };
  }

  interface OpenReviewContent {
    title?: string | { value?: string };
    authors?: string[] | { value?: string[] };
    abstract?: string | { value?: string };
  }
  const data = await response.json() as { notes?: { content?: OpenReviewContent }[] };
  const note = data.notes?.[0];

  if (!note) {
    return { url, title: '', authors: '', abstract: '', source: 'OpenReview' };
  }

  const content = note.content ?? {};
  
  // Handle both old and new OpenReview API formats
  const title = typeof content.title === 'object' && content.title?.value
    ? content.title.value
    : typeof content.title === 'string'
      ? content.title
      : '';
  
  let authors = '';
  if (content.authors) {
    if (typeof content.authors === 'object' && 'value' in content.authors && Array.isArray(content.authors.value)) {
      authors = content.authors.value.join(', ');
    } else if (Array.isArray(content.authors)) {
      authors = content.authors.join(', ');
    }
  }
  
  const abstract = typeof content.abstract === 'object' && content.abstract?.value
    ? content.abstract.value
    : typeof content.abstract === 'string'
      ? content.abstract
      : '';

  return {
    url,
    title,
    authors,
    abstract,
    source: 'OpenReview',
  };
}

// Fetch metadata from IEEE (using DOI if available in URL)
async function fetchIEEEMetadata(url: string): Promise<PaperMetadata> {
  // Try to extract DOI from IEEE URL
  const doiMatch = url.match(/ieee\.org\/document\/(\d+)/i);

  if (doiMatch?.[1]) {
    // IEEE Xplore document ID - try to get page and extract DOI
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PaperBookmark/1.0)',
        },
      });
      const html = await response.text();

      // Try to extract DOI from the page
      const pageDoi = html.match(/"doi":"(10\.[^"]+)"/)?.[1];
      if (pageDoi) {
        const metadata = await fetchDoiMetadata(`https://doi.org/${pageDoi}`);
        return { ...metadata, source: 'IEEE' };
      }

      // Extract title from meta tags
      const title = html.match(/<meta\s+(?:name|property)="(?:citation_title|og:title)"\s+content="([^"]+)"/i)?.[1] ?? '';
      const authorsMatch = html.match(/<meta\s+name="citation_author"\s+content="([^"]+)"/gi);
      const authors = authorsMatch
        ? authorsMatch.map((m) => m.match(/content="([^"]+)"/)?.[1] ?? '').filter(Boolean).join(', ')
        : '';
      const abstract = html.match(/<meta\s+(?:name|property)="(?:description|og:description)"\s+content="([^"]+)"/i)?.[1] ?? '';

      return { url, title, authors, abstract, source: 'IEEE' };
    } catch {
      return { url, title: '', authors: '', abstract: '', source: 'IEEE' };
    }
  }

  return { url, title: '', authors: '', abstract: '', source: 'IEEE' };
}

// Fetch metadata from ACM Digital Library
async function fetchACMMetadata(url: string): Promise<PaperMetadata> {
  // Extract DOI from ACM URL
  const doiMatch = url.match(/dl\.acm\.org\/doi\/(10\.\d{4,}\/[^\s?#]+)/i);

  if (doiMatch?.[1]) {
    const metadata = await fetchDoiMetadata(`https://doi.org/${doiMatch[1]}`);
    return { ...metadata, source: 'ACM' };
  }

  // Try to fetch page and extract metadata from meta tags
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PaperBookmark/1.0)',
      },
    });
    const html = await response.text();

    const title = html.match(/<meta\s+(?:name|property)="(?:citation_title|og:title)"\s+content="([^"]+)"/i)?.[1] ?? '';
    const authorsMatch = html.match(/<meta\s+name="citation_author"\s+content="([^"]+)"/gi);
    const authors = authorsMatch
      ? authorsMatch.map((m) => m.match(/content="([^"]+)"/)?.[1] ?? '').filter(Boolean).join(', ')
      : '';
    const abstract = html.match(/<meta\s+(?:name|property)="(?:description|og:description)"\s+content="([^"]+)"/i)?.[1] ?? '';

    return { url, title, authors, abstract, source: 'ACM' };
  } catch {
    return { url, title: '', authors: '', abstract: '', source: 'ACM' };
  }
}

// Maximum PDF size to download (50MB)
const MAX_PDF_SIZE = 50 * 1024 * 1024;

// Fetch and parse PDF from URL
async function fetchPdfMetadata(url: string, source: string): Promise<PaperMetadata> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PaperBookmark/1.0)',
      },
    });

    if (!response.ok) {
      return { url, title: '', authors: '', abstract: '', source };
    }

    // Check content length to avoid downloading huge files
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_PDF_SIZE) {
      console.warn(`PDF too large to parse: ${url}`);
      return { url, title: '', authors: '', abstract: '', source };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return await parsePdfBuffer(buffer, url, source);
  } catch (error) {
    console.error('Error fetching PDF:', error);
    return { url, title: '', authors: '', abstract: '', source };
  }
}

// Parse PDF buffer and extract metadata
async function parsePdfBuffer(buffer: Buffer, url: string, source: string): Promise<PaperMetadata> {
  let parser: PDFParse | null = null;
  try {
    parser = new PDFParse({ data: buffer });
    
    // Get PDF info/metadata
    const infoResult = await parser.getInfo();
    const info = infoResult.info ?? {};
    
    let title = (info as Record<string, unknown>).Title as string ?? '';
    let authors = (info as Record<string, unknown>).Author as string ?? '';
    
    // Get text content from first few pages
    const textResult = await parser.getText({ first: 3 });
    const fullText = textResult.pages.map(p => p.text).join('\n');
    
    // If no title in metadata, try to extract from first page content
    if (!title && fullText) {
      // Usually the title is in the first few lines and is often in larger font
      // We'll try to get the first meaningful line as title
      const lines = fullText.split('\n').filter((line: string) => line.trim().length > 0);
      
      // Skip common header elements and get first substantial line
      for (const line of lines.slice(0, 10)) {
        const trimmed = line.trim();
        // Skip lines that look like headers, page numbers, or are too short
        if (trimmed.length > 10 && 
            trimmed.length < 300 &&
            !trimmed.match(/^(page|vol|volume|issue|doi|arxiv|\d+)[\s.:]/i) &&
            !trimmed.match(/^\d+$/) &&
            !trimmed.match(/^https?:\/\//)) {
          title = trimmed;
          break;
        }
      }
    }
    
    // Try to extract abstract from content
    let abstract = '';
    if (fullText) {
      // Look for abstract section
      const abstractMatch = fullText.match(/\babstract\b[:\s]*\n?([\s\S]{50,1500}?)(?=\n\s*\n|\b(?:introduction|keywords|1\s*\.?\s*introduction)\b)/i);
      if (abstractMatch?.[1]) {
        abstract = abstractMatch[1]
          .replace(/\s+/g, ' ')
          .trim();
      }
    }

    return {
      url,
      title: title.trim(),
      authors: authors.trim(),
      abstract,
      source,
    };
  } catch (error) {
    console.error('Error parsing PDF:', error);
    return { url, title: '', authors: '', abstract: '', source };
  } finally {
    // Clean up parser resources
    if (parser) {
      await parser.destroy();
    }
  }
}

// Generic metadata extraction from HTML meta tags or PDF
async function fetchGenericMetadata(url: string, source: string): Promise<PaperMetadata> {
  try {
    // Check if URL is a PDF
    const isPdf = url.toLowerCase().endsWith('.pdf') || url.includes('/pdf/');
    
    if (isPdf) {
      return await fetchPdfMetadata(url, source);
    }

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PaperBookmark/1.0)',
      },
    });
    
    // Check content-type to detect PDFs that don't have .pdf extension
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/pdf')) {
      const buffer = Buffer.from(await response.arrayBuffer());
      return await parsePdfBuffer(buffer, url, source);
    }
    
    const html = await response.text();

    // Try citation meta tags first (commonly used by academic sites)
    let title = html.match(/<meta\s+name="citation_title"\s+content="([^"]+)"/i)?.[1] ?? '';
    if (!title) {
      title = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i)?.[1] ?? '';
    }
    if (!title) {
      title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() ?? '';
    }

    const authorsMatch = html.match(/<meta\s+name="citation_author"\s+content="([^"]+)"/gi);
    let authors = '';
    if (authorsMatch) {
      authors = authorsMatch.map((m) => m.match(/content="([^"]+)"/)?.[1] ?? '').filter(Boolean).join(', ');
    } else {
      authors = html.match(/<meta\s+name="author"\s+content="([^"]+)"/i)?.[1] ?? '';
    }

    let abstract = html.match(/<meta\s+name="citation_abstract"\s+content="([^"]+)"/i)?.[1] ?? '';
    if (!abstract) {
      abstract = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)?.[1] ?? '';
    }
    if (!abstract) {
      abstract = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i)?.[1] ?? '';
    }

    return {
      url,
      title: decodeHtmlEntities(title),
      authors: decodeHtmlEntities(authors),
      abstract: decodeHtmlEntities(abstract),
      source,
    };
  } catch {
    return { url, title: '', authors: '', abstract: '', source };
  }
}

// Helper to decode HTML entities
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function getAllTags(allPapers: LokiPaper[]): string[] {
  const tagsSet = new Set<string>();
  allPapers.forEach((paper) => {
    if (paper.tags && Array.isArray(paper.tags)) {
      paper.tags.forEach((tag) => tagsSet.add(tag));
    }
  });
  return Array.from(tagsSet).sort();
}

function getSsrData(query: PaperQuery): { list: Paper[]; tags: string[]; queryState: SsrQueryState } {
  const allPapers = papers.find();
  const tags = getAllTags(allPapers);
  const { sort, order, sortValue } = parseSortOrder(query);
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  const tag = typeof query.tag === 'string' ? query.tag : '';

  let results = papers.chain();

  if (search) {
    const searchLower = search.toLowerCase();
    results = results.where((paper: LokiPaper) => {
      return (
        (paper.title?.toLowerCase().includes(searchLower)) ||
        (paper.authors?.toLowerCase().includes(searchLower)) ||
        (paper.abstract?.toLowerCase().includes(searchLower)) ||
        (paper.tags?.some((t) => t.toLowerCase().includes(searchLower)))
      );
    });
  }

  if (tag) {
    results = results.where((paper: LokiPaper) => paper.tags?.includes(tag));
  }

  const isDescending = order === 'desc';
  results = results.simplesort(sort, { desc: isDescending });

  const list = results.data().map(cleanPaper);

  return {
    list,
    tags,
    queryState: {
      search,
      tag,
      sortValue,
    },
  };
}

interface SsrQueryState {
  search: string;
  tag: string;
  sortValue: string;
}

function parseSortOrder(query: PaperQuery): { sort: keyof LokiPaper; order: 'asc' | 'desc'; sortValue: string } {
  const allowedSorts: Array<keyof LokiPaper> = ['dateAdded', 'title', 'accessCount'];
  let sort: keyof LokiPaper = 'dateAdded';
  let order: 'asc' | 'desc' = 'desc';

  const sortParam = typeof query.sort === 'string' ? query.sort : '';
  const orderParam = typeof query.order === 'string' ? query.order : '';

  if (sortParam.includes('-')) {
    const [sortPart, orderPart] = sortParam.split('-');
    if (allowedSorts.includes(sortPart as keyof LokiPaper)) {
      sort = sortPart as keyof LokiPaper;
    }
    if (orderPart === 'asc' || orderPart === 'desc') {
      order = orderPart;
    }
  } else {
    if (allowedSorts.includes(sortParam as keyof LokiPaper)) {
      sort = sortParam as keyof LokiPaper;
    }
    if (orderParam === 'asc' || orderParam === 'desc') {
      order = orderParam;
    }
  }

  return {
    sort,
    order,
    sortValue: `${sort}-${order}`,
  };
}

// Server-side rendered HTML that mirrors the client UI
function renderSsrApp(papersList: Paper[], tags: string[], queryState: SsrQueryState): string {
  const hasPapers = papersList.length > 0;
  const paperCards = papersList.map((paper) => {
    const safeTitle = escapeHtml(paper.title || 'Untitled Paper');
    const safeAuthors = escapeHtml(paper.authors || '');
    const safeAbstract = escapeHtml(paper.abstract || '');
    const safeSource = escapeHtml(paper.source || 'Web');
    const safeUrl = escapeHtml(paper.url || '');
    const safeDate = escapeHtml(formatRelativeDate(paper.dateAdded));
    const sourceClass = escapeClassName(paper.source || 'web');
    const tagChips = (paper.tags ?? []).map((tag) => `<span class="paper-tag">${escapeHtml(tag)}</span>`).join('');

    return `
      <article class="paper-card" onclick="openPaper('${escapeJsString(paper._id ?? '')}', '${escapeJsString(paper.url ?? '')}')">
        <div class="paper-header">
          <span class="paper-source ${sourceClass}">${safeSource}</span>
          <div class="paper-actions" onclick="event.stopPropagation()">
            <button class="paper-action-btn" onclick="editPaper('${escapeJsString(paper._id ?? '')}')" title="Edit">✏️</button>
            <button class="paper-action-btn" onclick="openDeleteModal('${escapeJsString(paper._id ?? '')}')" title="Delete">🗑️</button>
          </div>
        </div>
        <h3 class="paper-title">${safeTitle}</h3>
        ${safeAuthors ? `<p class="paper-authors">${safeAuthors}</p>` : ''}
        ${safeAbstract ? `<p class="paper-abstract">${safeAbstract}</p>` : ''}
        <div class="paper-footer">
          <div class="paper-tags">${tagChips}</div>
          <span class="paper-date">${safeDate}</span>
        </div>
      </article>
    `;
  }).join('');

  const tagOptions = tags.map((tag) => `
    <option value="${escapeHtml(tag)}" ${tag === queryState.tag ? 'selected' : ''}>${escapeHtml(tag)}</option>
  `).join('');

  const initialData = JSON.stringify({ papers: papersList, tags }).replace(/</g, '\\u003c');

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Paper Bookmark</title>
      <link rel="stylesheet" href="styles.css">
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    </head>
    <body data-ssr="true">
      <div class="app">
        <header class="header">
          <div class="header-content">
            <h1 class="logo">
              <span class="logo-icon">📚</span>
              <span class="logo-text">Paper Bookmark</span>
              <span id="syncIndicator" class="sync-indicator" title="Connecting..."></span>
            </h1>
            <button class="btn btn-primary add-btn" onclick="openAddModal()">
              <span class="btn-icon">+</span>
              <span class="btn-text">Add Paper</span>
            </button>
          </div>
        </header>

        <form id="searchForm" class="search-bar" method="GET" action="">
          <div class="search-container">
            <input
              type="text"
              id="searchInput"
              name="search"
              placeholder="Search papers..."
              class="search-input"
              value="${escapeHtml(queryState.search)}"
            >
            <span class="search-icon">🔍</span>
          </div>
          <div class="filter-container">
            <select id="tagFilter" name="tag" class="filter-select" onchange="this.form.submit()">
              <option value="">All Tags</option>
              ${tagOptions}
            </select>
            <select id="sortSelect" name="sort" class="filter-select" onchange="this.form.submit()">
              <option value="dateAdded-desc" ${queryState.sortValue === 'dateAdded-desc' ? 'selected' : ''}>Newest First</option>
              <option value="dateAdded-asc" ${queryState.sortValue === 'dateAdded-asc' ? 'selected' : ''}>Oldest First</option>
              <option value="title-asc" ${queryState.sortValue === 'title-asc' ? 'selected' : ''}>Title A-Z</option>
              <option value="title-desc" ${queryState.sortValue === 'title-desc' ? 'selected' : ''}>Title Z-A</option>
              <option value="accessCount-desc" ${queryState.sortValue === 'accessCount-desc' ? 'selected' : ''}>Most Accessed</option>
            </select>
          </div>
        </form>

        <main class="papers-container">
          <div id="papersList" class="papers-list ${hasPapers ? '' : 'hidden'}">
            ${paperCards}
          </div>
          <div id="emptyState" class="empty-state ${hasPapers ? 'hidden' : ''}">
            <div class="empty-icon">📄</div>
            <h2>No papers yet</h2>
            <p>Start by adding your first research paper</p>
            <button class="btn btn-primary" onclick="openAddModal()">Add Paper</button>
          </div>
          <div id="loadingState" class="loading-state hidden">
            <div class="spinner"></div>
            <p>Loading papers...</p>
          </div>
        </main>

        <div id="paperModal" class="modal hidden">
          <div class="modal-overlay" onclick="closeModal()"></div>
          <div class="modal-content">
            <div class="modal-header">
              <h2 id="modalTitle">Add Paper</h2>
              <button class="modal-close" onclick="closeModal()">×</button>
            </div>
            <form id="paperForm" onsubmit="handleSubmit(event)">
              <div class="form-group">
                <label for="paperUrl">Paper URL *</label>
                <div class="url-input-group">
                  <input
                    type="url"
                    id="paperUrl"
                    required
                    placeholder="https://arxiv.org/abs/..."
                    class="form-input"
                  >
                  <button type="button" class="btn btn-secondary fetch-btn" onclick="fetchMetadata()">
                    <span id="fetchBtnText">Fetch Info</span>
                  </button>
                </div>
              </div>
              <div class="form-group">
                <label for="paperTitle">Title *</label>
                <input
                  type="text"
                  id="paperTitle"
                  required
                  placeholder="Paper title"
                  class="form-input"
                >
              </div>
              <div class="form-group">
                <label for="paperAuthors">Authors</label>
                <input
                  type="text"
                  id="paperAuthors"
                  placeholder="Author names (comma separated)"
                  class="form-input"
                >
              </div>
              <div class="form-group">
                <label for="paperAbstract">Abstract / Notes</label>
                <textarea
                  id="paperAbstract"
                  placeholder="Paper abstract or your notes..."
                  class="form-input form-textarea"
                  rows="4"
                ></textarea>
              </div>
              <div class="form-group">
                <label for="paperTags">Tags</label>
                <input
                  type="text"
                  id="paperTags"
                  placeholder="machine-learning, nlp, transformers"
                  class="form-input"
                >
                <small class="form-hint">Separate tags with commas</small>
              </div>
              <input type="hidden" id="paperId">
              <div class="form-actions">
                <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button type="submit" class="btn btn-primary" id="submitBtn">Save Paper</button>
              </div>
            </form>
          </div>
        </div>

        <div id="deleteModal" class="modal hidden">
          <div class="modal-overlay" onclick="closeDeleteModal()"></div>
          <div class="modal-content modal-small">
            <div class="modal-header">
              <h2>Delete Paper</h2>
              <button class="modal-close" onclick="closeDeleteModal()">×</button>
            </div>
            <p class="delete-message">Are you sure you want to delete this paper? This action cannot be undone.</p>
            <div class="form-actions">
              <button class="btn btn-secondary" onclick="closeDeleteModal()">Cancel</button>
              <button class="btn btn-danger" onclick="confirmDelete()">Delete</button>
            </div>
          </div>
        </div>

        <div id="toast" class="toast hidden">
          <span id="toastMessage"></span>
        </div>
      </div>

      <script>window.__SSR__ = true; window.__INITIAL_DATA__ = ${initialData};</script>
      <script src="app.js"></script>
      <script>
        (function () {
          const form = document.getElementById('searchForm');
          const input = document.getElementById('searchInput');
          if (!form || !input) return;
          let timer = null;
          input.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(() => form.submit(), 300);
          });
        })();
      </script>
    </body>
    </html>
  `;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJsString(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeClassName(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

function formatRelativeDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffTime = Math.abs(now.getTime() - date.getTime());
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// Serve frontend for all non-API routes
app.get('*', (req: Request<unknown, unknown, unknown, PaperQuery>, res: Response) => {
  try {
    const { list, tags, queryState } = getSsrData(req.query);
    const html = renderSsrApp(list, tags, queryState);
    res.status(200).send(html);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).send(`<pre>SSR error: ${errorMessage}</pre>`);
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`📚 Paper Bookmark server running on http://localhost:${PORT}`);
  console.log(`🔄 SSE ready for real-time sync (Cloudflare compatible)`);
});

export { app };
