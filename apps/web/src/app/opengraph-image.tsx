import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const alt = 'KEEL — your financial system of record';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/** Social share card: wordmark + tagline on the dark stone canvas, emerald mark. */
export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '96px',
          backgroundColor: '#0c0a09',
          color: '#f5f5f4',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <svg width="72" height="72" viewBox="0 0 24 24" fill="none">
            <path
              d="M5 4v9a7 7 0 0 0 7 7 7 7 0 0 0 7-7"
              stroke="#10b981"
              strokeWidth="2.25"
              strokeLinecap="round"
            />
          </svg>
          <div style={{ fontSize: 64, fontWeight: 600, letterSpacing: '-0.02em' }}>keel</div>
        </div>
        <div
          style={{
            marginTop: 48,
            fontSize: 72,
            fontWeight: 600,
            letterSpacing: '-0.03em',
            lineHeight: 1.1,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <span>Every dollar,</span>
          <span style={{ color: '#10b981' }}>accounted for.</span>
        </div>
        <div style={{ marginTop: 40, fontSize: 30, color: '#a8a29e', maxWidth: 900 }}>
          Your financial system of record — a double-entry ledger with AI that asks before it
          acts.
        </div>
      </div>
    ),
    size,
  );
}
