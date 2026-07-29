import { neon } from '@neondatabase/serverless';

// 현장 설문과 익명 방문 계측을 받는다.
//
// 두 가지를 한 엔드포인트로 받는 이유는 재방문율이 이 서비스의 결정적 지표이고
// (docs/proposal.md 7.2), 그걸 재려면 설문 응답자와 방문자를 같은 ID로 이어야 하기
// 때문이다. 남기는 것은 브라우저가 만든 무작위 ID뿐이라 개인을 식별하지 않는다.

const maxNoteLength = 1000;
const maxFieldLength = 120;

interface RequestLike {
  method?: string;
  body?: unknown;
}

interface ResponseLike {
  status(code: number): ResponseLike;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

function readText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : null;
}

function readBody(body: unknown): Record<string, unknown> | null {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : null;
}

export default async function handler(request: RequestLike, response: ResponseLike): Promise<void> {
  response.setHeader('Cache-Control', 'no-store');

  if (request.method !== 'POST') {
    response.status(405).json({ error: 'POST만 받습니다.' });
    return;
  }

  const body = readBody(request.body);
  if (!body) {
    response.status(400).json({ error: '본문을 읽지 못했습니다.' });
    return;
  }

  const visitorId = readText(body.visitorId, 64);
  if (!visitorId) {
    response.status(400).json({ error: 'visitorId가 필요합니다.' });
    return;
  }

  const kind = body.kind === 'visit' ? 'visit' : 'survey';
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // 저장소 미설정은 설정 실패다. 방문 계측이 화면을 막으면 안 되므로 조용히 받는다.
    response.status(503).json({ error: '저장소를 사용할 수 없습니다.' });
    return;
  }

  const payload = {
    entry: readText(body.entry, maxFieldLength),
    stopName: readText(body.stopName, maxFieldLength),
    routeName: readText(body.routeName, maxFieldLength),
    destination: readText(body.destination, maxFieldLength),
    frequency: readText(body.frequency, maxFieldLength),
    passedBuses: readText(body.passedBuses, maxFieldLength),
    walkedUpstream: readText(body.walkedUpstream, maxFieldLength),
    note: readText(body.note, maxNoteLength),
  };

  try {
    const sql = neon(databaseUrl);
    await sql`
      INSERT INTO feedback_events (kind, visitor_id, payload)
      VALUES (${kind}, ${visitorId}, ${JSON.stringify(payload)})
    `;
    response.status(204).json(null);
  } catch (error: unknown) {
    // 원문을 그대로 흘리면 접속 문자열이 섞일 수 있다.
    console.error('feedback insert 실패', error instanceof Error ? error.name : 'unknown');
    response.status(502).json({ error: '저장에 실패했습니다.' });
  }
}
