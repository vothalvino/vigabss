// =============================================================================
// SignatureCanvas — the drawn signature of a legal document
// =============================================================================
// The pad the technician hands the customer on site (WorkOrders) and the one
// the customer uses on its own phone through a remote signing link
// (PublicSigning). onChange gets a PNG data URL, or null once cleared.
// =============================================================================

import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { styles } from '@/pages/crudStyles';

export function SignatureCanvas({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);

  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (rect.width ? e.currentTarget.width / rect.width : 1),
      y: (e.clientY - rect.top) * (rect.height ? e.currentTarget.height / rect.height : 1),
    };
  }
  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    drawing.current = true;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const { x, y } = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const { x, y } = pos(e);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#111';
    ctx.lineTo(x, y);
    ctx.stroke();
    dirty.current = true;
  }
  function end() {
    drawing.current = false;
    if (dirty.current && canvasRef.current) onChange(canvasRef.current.toDataURL('image/png'));
  }
  function clear() {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (c && ctx) ctx.clearRect(0, 0, c.width, c.height);
    dirty.current = false;
    onChange(null);
  }

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={420}
        height={140}
        data-testid="signature-canvas"
        style={{ border: '1px dashed var(--border-color, #9ca3af)', borderRadius: 8, background: '#fff', touchAction: 'none', width: '100%', maxWidth: 420 }}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
      />
      <button type="button" style={{ ...styles.btnSecondary, marginTop: 4, padding: '3px 10px', fontSize: '0.78rem' }} onClick={clear}>
        {t('workOrders.documents.clearSignature')}
      </button>
    </div>
  );
}
