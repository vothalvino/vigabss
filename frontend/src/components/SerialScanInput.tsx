// =============================================================================
// A cash-bag serial: typed, or read from the bag's code with the camera
// =============================================================================
// The typed field is always there. "Escanear" appears only where the browser
// has BarcodeDetector and a camera (Chrome on Android; not Safari or Firefox),
// reads QR, Code 128 and Code 39 labels and hands the first value over as if
// it had been typed. The serial is normalized like the server does it
// (trimmed, upper case), so what the person sees is what is matched. The
// component is its own <form>: do not put it inside another one.
// =============================================================================

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

const FORMATS = ['qr_code', 'code_128', 'code_39'];
export const SERIAL_MAX = 64;

interface DetectedBarcode { rawValue?: string }
interface BarcodeDetectorLike { detect(source: HTMLVideoElement): Promise<DetectedBarcode[]> }
interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

/** The serial as the server stores it: trimmed and upper case. */
export function normalizeSerial(raw: string): string {
  return raw.trim().toUpperCase();
}

/** The browser's BarcodeDetector when it can also open a camera, else null. */
export function barcodeDetector(): BarcodeDetectorCtor | null {
  const ctor: unknown = Reflect.get(globalThis, 'BarcodeDetector');
  if (typeof ctor !== 'function') return null;
  if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') return null;
  return ctor as BarcodeDetectorCtor;
}

export interface SerialScanInputProps {
  label: string;
  submitLabel: string;
  onSerial: (serial: string) => void;
  busy?: boolean;
  help?: string;
  /** Empty the field after each serial (adding several to a list). */
  clearOnSubmit?: boolean;
  /** Shown under the field, e.g. the server's refusal. */
  error?: string;
}

export function SerialScanInput({ label, submitLabel, onSerial, busy = false, help, clearOnSubmit = false, error }: SerialScanInputProps) {
  const { t } = useTranslation();
  const id = useId();
  const [value, setValue] = useState('');
  const [scanning, setScanning] = useState(false);
  const [localError, setLocalError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const onSerialRef = useRef(onSerial);
  const Detector = useMemo(barcodeDetector, []);

  useEffect(() => { onSerialRef.current = onSerial; });

  useEffect(() => {
    if (!scanning || !Detector) return undefined;
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: number | undefined;

    async function start(Ctor: BarcodeDetectorCtor) {
      try {
        const supported = Ctor.getSupportedFormats ? await Ctor.getSupportedFormats() : FORMATS;
        const formats = FORMATS.filter(f => supported.includes(f));
        if (formats.length === 0) throw new Error('no supported formats');
        const detector = new Ctor({ formats });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        const video = videoRef.current;
        if (stopped || !video) return;
        video.srcObject = stream;
        await video.play();
        const tick = async () => {
          if (stopped) return;
          try {
            const codes = await detector.detect(video);
            const raw = codes.map(c => c.rawValue ?? '').find(v => v.trim());
            if (raw) {
              const serial = normalizeSerial(raw).slice(0, SERIAL_MAX);
              setScanning(false);
              setValue(clearOnSubmit ? '' : serial);
              onSerialRef.current(serial);
              return;
            }
          } catch {
            // A frame that cannot be read yet; try the next one.
          }
          timer = window.setTimeout(() => { void tick(); }, 250);
        };
        void tick();
      } catch {
        if (!stopped) {
          setLocalError(t('serialScan.cameraError'));
          setScanning(false);
        }
      }
    }
    void start(Detector);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      stream?.getTracks().forEach(track => track.stop());
    };
  }, [scanning, Detector, clearOnSubmit, t]);

  function submit(e: FormEvent) {
    e.preventDefault();
    setLocalError('');
    const serial = normalizeSerial(value);
    if (!serial) { setLocalError(t('serialScan.required')); return; }
    if (serial.length > SERIAL_MAX) { setLocalError(t('serialScan.tooLong', { max: SERIAL_MAX })); return; }
    if (clearOnSubmit) setValue('');
    onSerial(serial);
  }

  const shownError = localError || error;
  return (
    <form onSubmit={submit} noValidate className="serial-scan" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="punto-field" style={{ marginBottom: 0 }}>
        <label htmlFor={`${id}-serial`}>{label}</label>
        <input
          id={`${id}-serial`}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={SERIAL_MAX}
          value={value}
          onChange={e => setValue(e.target.value)}
          aria-describedby={help ? `${id}-help` : undefined}
          aria-invalid={shownError ? true : undefined}
        />
      </div>
      {help && <p id={`${id}-help`} style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{help}</p>}
      {shownError && <p role="alert" style={{ margin: 0, padding: '10px 12px', borderRadius: 8, background: 'var(--danger-soft)', color: 'var(--danger)', fontSize: '0.9rem' }}>{shownError}</p>}
      {scanning && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <video ref={videoRef} muted playsInline aria-label={t('serialScan.cameraLabel')} style={{ width: '100%', maxHeight: 260, borderRadius: 8, background: '#000', objectFit: 'cover' }} />
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{t('serialScan.aim')}</p>
        </div>
      )}
      <button type="submit" className="punto-btn-primary" disabled={busy}>{submitLabel}</button>
      {Detector && (
        <button type="button" className="punto-btn-secondary" disabled={busy} onClick={() => { setLocalError(''); setScanning(s => !s); }}>
          {scanning ? t('serialScan.stop') : t('serialScan.scan')}
        </button>
      )}
    </form>
  );
}
