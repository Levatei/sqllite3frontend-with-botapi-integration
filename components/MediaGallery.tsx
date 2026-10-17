'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { ArrowDownUp, Play, Trash2, Upload, X } from 'lucide-react';
import { deleteMedia, updateMedia, uploadMedia, type MediaItem } from '@/lib/api';
import { useMediaList } from '@/hooks/use-media';
import { makeThumb } from '@/lib/client-thumb';

export interface MediaSelection {
  type: 'order' | 'equipment' | 'batch';
  id: number | string;
  label: string;
  model?: string | null;
}

interface MediaGalleryProps {
  selection: MediaSelection;
  refreshKey: number;
  onChanged: () => void;
  onNotice: (msg: string) => void;
}

function fmtDate(value: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function MediaGallery({ selection, refreshKey, onChanged, onNotice }: MediaGalleryProps) {
  const orderId = selection.type === 'order' ? Number(selection.id) : null;
  const equipmentId = selection.type === 'equipment' ? Number(selection.id) : null;
  const batchId = selection.type === 'batch' ? String(selection.id) : null;
  const model = selection.type === 'batch' ? selection.model ?? null : null;

  const { items, loading, error, reload } = useMediaList({
    enabled: true,
    orderId,
    equipmentId,
    batchId,
    model,
    refreshKey,
  });

  const [reversed, setReversed] = useState(false);
  const [lightbox, setLightbox] = useState<MediaItem | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const displayed = useMemo(
    () => (reversed ? [...items].reverse() : items),
    [items, reversed]
  );

  const refreshAll = useCallback(() => {
    reload();
    onChanged();
  }, [reload, onChanged]);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setUploading(true);
      let ok = 0;
      try {
        for (const file of Array.from(files)) {
          const form = new FormData();
          form.append('file', file);
          const thumb = await makeThumb(file);
          if (thumb) form.append('thumb', thumb, 'thumb.jpg');
          form.append('source', 'web');
          if (orderId != null) form.append('order_id', String(orderId));
          if (equipmentId != null) form.append('equipment_id', String(equipmentId));
          if (batchId) {
            form.append('batch_id', batchId);
            if (model) form.append('model', model);
          }
          await uploadMedia(form);
          ok += 1;
        }
        onNotice(ok > 1 ? `Добавлено файлов: ${ok}.` : 'Медиафайл добавлен.');
        refreshAll();
      } catch (e) {
        onNotice(e instanceof Error ? e.message : 'Ошибка загрузки файла');
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = '';
      }
    },
    [orderId, equipmentId, batchId, model, onNotice, refreshAll]
  );

  const editCaption = useCallback(
    async (item: MediaItem) => {
      const next = window.prompt('Подпись к файлу:', item.caption ?? '');
      if (next === null) return;
      try {
        const res = await updateMedia(item.media_id, { caption: next.trim() || null });
        setLightbox((cur) => (cur && cur.media_id === item.media_id ? res.media : cur));
        refreshAll();
      } catch (e) {
        onNotice(e instanceof Error ? e.message : 'Не удалось сохранить подпись');
      }
    },
    [onNotice, refreshAll]
  );

  const removeItem = useCallback(
    async (item: MediaItem) => {
      if (!window.confirm('Удалить медиафайл? Действие необратимо.')) return;
      try {
        await deleteMedia(item.media_id);
        setLightbox(null);
        onNotice('Медиафайл удалён.');
        refreshAll();
      } catch (e) {
        onNotice(e instanceof Error ? e.message : 'Не удалось удалить файл');
      }
    },
    [onNotice, refreshAll]
  );

  return (
    <section className="data-panel media-gallery">
      <div className="panel-toolbar">
        <div className="toolbar-title">
          <div className="section-icon"><Play size={15} /></div>
          <div>
            <strong>{selection.label}</strong>
            <span>
              {loading ? 'загрузка…' : `${items.length} файл(ов)`}
              {model ? ` · модель ${model}` : ''}
            </span>
          </div>
        </div>
        <div className="toolbar-actions">
          <button
            className={`toolbar-button ${reversed ? 'active' : ''}`}
            onClick={() => setReversed((v) => !v)}
            title="Порядок сборки — обратный"
          >
            <ArrowDownUp size={14} /> {reversed ? 'Сборка' : 'Разборка'}
          </button>
          <button
            className="toolbar-button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
          >
            <Upload size={14} /> {uploading ? 'Загрузка…' : 'Загрузить'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,video/*"
            multiple
            hidden
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>
      </div>

      {error && <p className="form-error" style={{ padding: '0 18px' }}>{error}</p>}

      {!loading && items.length === 0 && !error ? (
        <div className="empty-state">
          <div className="empty-illustration"><Play size={22} /></div>
          <h3>Пока нет медиафайлов</h3>
          <p>Загрузите фото или видео кнопкой «Загрузить».</p>
        </div>
      ) : (
        <div className="media-grid">
          {displayed.map((m) => (
            <button
              key={m.media_id}
              className="media-tile"
              onClick={() => setLightbox(m)}
              title={m.caption ?? 'Открыть'}
            >
              <span className="media-tile-thumb">
                {m.kind === 'video' && <span className="media-tile-play"><Play size={20} /></span>}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/media/${m.media_id}/thumb`}
                  alt={m.caption ?? ''}
                  loading="lazy"
                  onError={(e) => {
                    e.currentTarget.style.visibility = 'hidden';
                  }}
                />
              </span>
              <span className="media-tile-meta">
                <span className="media-step">{m.step_no ?? '—'}</span>
                <span className="media-caption">
                  {m.caption || (m.kind === 'video' ? 'Видео' : 'Фото')}
                </span>
                <span className="media-date">{fmtDate(m.created_at)}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {lightbox && (
        <div className="modal-overlay" onClick={() => setLightbox(null)}>
          <div className="media-lightbox" onClick={(e) => e.stopPropagation()}>
            <div className="media-lightbox-head">
              <span>{lightbox.caption || (lightbox.kind === 'video' ? 'Видео' : 'Фото')}</span>
              <button className="icon-button" aria-label="Закрыть" onClick={() => setLightbox(null)}>
                <X size={17} />
              </button>
            </div>
            {lightbox.kind === 'video' ? (
              <video
                className="media-lightbox-media"
                src={`/api/media/${lightbox.media_id}/file`}
                controls
                autoPlay
                preload="metadata"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="media-lightbox-media"
                src={`/api/media/${lightbox.media_id}/file`}
                alt={lightbox.caption ?? ''}
              />
            )}
            <div className="media-lightbox-foot">
              <a
                className="button secondary"
                href={`/api/media/${lightbox.media_id}/file`}
                download
              >
                Скачать
              </a>
              <button className="button secondary" onClick={() => editCaption(lightbox)}>
                Подпись
              </button>
              <button className="button danger-solid" onClick={() => removeItem(lightbox)}>
                <Trash2 size={14} /> Удалить
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
