'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';

interface DateFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

const MONTHS = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];
const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function toISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Понимает `YYYY-MM-DD` и `DD.MM.YYYY` (формат, уже встречающийся в базе). */
function parseDate(value: string): Date | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const ru = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value.trim());
  if (ru) {
    const d = new Date(Number(ru[3]), Number(ru[2]) - 1, Number(ru[1]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function display(value: string): string {
  const parsed = parseDate(value);
  if (!parsed) return value.trim();
  return `${pad(parsed.getDate())} ${MONTHS_GEN[parsed.getMonth()]} ${parsed.getFullYear()}`;
}

export function DateField({ value, onChange, placeholder = '— выберите дату —' }: DateFieldProps) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => parseDate(value), [value]);
  const [view, setView] = useState(() => selected ?? new Date());
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) setView(selected ?? new Date());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const days = useMemo(() => {
    const year = view.getFullYear();
    const month = view.getMonth();
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7; // неделя с понедельника
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells: Array<{ date: Date; inMonth: boolean }> = [];
    for (let i = 0; i < offset; i += 1) {
      cells.push({ date: new Date(year, month, i - offset + 1), inMonth: false });
    }
    for (let d = 1; d <= daysInMonth; d += 1) {
      cells.push({ date: new Date(year, month, d), inMonth: true });
    }
    while (cells.length % 7 !== 0) {
      const last = cells[cells.length - 1].date;
      cells.push({ date: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1), inMonth: false });
    }
    return cells;
  }, [view]);

  const selectedISO = selected ? toISO(selected) : '';
  const todayISO = toISO(new Date());

  const pick = (d: Date) => {
    onChange(toISO(d));
    setOpen(false);
  };

  const shiftMonth = (delta: number) => {
    setView((v) => new Date(v.getFullYear(), v.getMonth() + delta, 1));
  };

  return (
    <div className="datefield" ref={ref}>
      <button
        type="button"
        className="datefield-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={value ? '' : 'datefield-placeholder'}>
          {value ? display(value) : placeholder}
        </span>
        <CalendarDays size={14} />
      </button>
      {open && (
        <div className="datefield-pop" role="dialog">
          <div className="datefield-head">
            <button type="button" className="datefield-nav" aria-label="Предыдущий месяц" onClick={() => shiftMonth(-1)}>
              <ChevronLeft size={14} />
            </button>
            <span className="datefield-title">
              {MONTHS[view.getMonth()]} {view.getFullYear()}
            </span>
            <button type="button" className="datefield-nav" aria-label="Следующий месяц" onClick={() => shiftMonth(1)}>
              <ChevronRight size={14} />
            </button>
          </div>
          <div className="datefield-grid">
            {DOW.map((d) => (
              <span key={d} className="datefield-dow">{d}</span>
            ))}
            {days.map(({ date, inMonth }, i) => {
              const iso = toISO(date);
              const cls = [
                'datefield-day',
                inMonth ? '' : 'muted',
                iso === selectedISO ? 'selected' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <button key={i} type="button" className={cls} onClick={() => pick(date)}>
                  {date.getDate()}
                </button>
              );
            })}
          </div>
          <div className="datefield-foot">
            <button type="button" className="datefield-link" onClick={() => pick(new Date())}>
              Сегодня
            </button>
            <button
              type="button"
              className="datefield-link"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
            >
              Очистить
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
