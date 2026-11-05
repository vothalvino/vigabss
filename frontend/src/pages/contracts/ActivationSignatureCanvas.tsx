// =============================================================================
// Activation signature canvas
// =============================================================================
// Moved out of ContractDetail.tsx, past the 1,500-line page limit (src/test/pageSize.test.ts),
// when its UI text moved into the locale files (FE-07).
// =============================================================================

import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cancelBtn } from '@/components/ClientFormModal';

export function ActivationSignatureCanvas({ onChange }: { onChange: (value: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);

  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (rect.width ? event.currentTarget.width / rect.width : 1),
      y: (event.clientY - rect.top) * (rect.height ? event.currentTarget.height / rect.height : 1),
    };
  }

  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    drawing.current = true;
    const context = canvasRef.current?.getContext('2d');
    if (!context) return;
    const { x, y } = point(event);
    context.beginPath();
    context.moveTo(x, y);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const context = canvasRef.current?.getContext('2d');
    if (!context) return;
    const { x, y } = point(event);
    context.lineWidth = 2;
    context.lineCap = 'round';
    context.strokeStyle = '#111';
    context.lineTo(x, y);
    context.stroke();
    dirty.current = true;
  }

  function end() {
    drawing.current = false;
    if (dirty.current && canvasRef.current) onChange(canvasRef.current.toDataURL('image/png'));
  }

  function clear() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
    dirty.current = false;
    onChange(null);
  }

  const { t } = useTranslation();
  return (
    <div>
      <canvas
        ref={canvasRef}
        width={420}
        height={140}
        data-testid="activation-signature-canvas"
        style={{ border: '1px dashed var(--border-strong, #9ca3af)', borderRadius: 8, background: '#fff', touchAction: 'none', width: '100%', maxWidth: 420 }}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
      />
      <button type="button" style={{ ...cancelBtn, marginTop: 4, padding: '3px 10px' }} onClick={clear}>
        {t('contractActivation.clearSignature')}
      </button>
    </div>
  );
}
