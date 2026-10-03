import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useMediaQuery } from '../hooks/useMediaQuery';
import { Bold } from '../pages/login/rich';
import { LockIcon } from './icons';

export const SLIDE_INTERVAL_MS = 5000;

type SlideKey = 'spend' | 'agents' | 'audit';

/*
 * Slides of design v14 (login.jsx `SlideSpend`/`SlideAgents`/`SlideAudit`): illustrations only,
 * without figures, hashes or agent lists. They are hidden from assistive technology; each slide
 * exposes its title as text instead.
 */

function SpendArt() {
  const { t } = useTranslation();
  return (
    <div className="card login-card-main">
      <div className="login-card-label">{t('auth.carousel.spend.card')}</div>
      <div className="login-card-text">{t('auth.carousel.spend.limit')}</div>
      <div className="login-meter-full" />
      <div className="login-card-note">
        <LockIcon size={13} className="login-icon-red" />
        {t('auth.carousel.spend.note')}
      </div>
    </div>
  );
}

function AgentsArt() {
  const { t } = useTranslation();
  return (
    <>
      <div className="card login-card-main">
        <div className="login-card-label">{t('auth.carousel.agents.card')}</div>
        <p className="login-bubble">{t('auth.carousel.agents.question')}</p>
        <div className="login-lines">
          <span className="login-line w-[92%]" />
          <span className="login-line w-[78%]" />
          <span className="login-line w-[55%]" />
        </div>
      </div>
      <div className="card login-float login-float-top">
        <div className="login-float-title">
          <LockIcon size={13} className="login-icon-accent" />
          {t('auth.carousel.agents.floatTitle')}
        </div>
        <div className="login-float-sub">{t('auth.carousel.agents.floatBody')}</div>
      </div>
    </>
  );
}

const AUDIT_ROWS = ['limit', 'query', 'denied'] as const;

function AuditArt() {
  const { t } = useTranslation();
  return (
    <>
      <div className="card login-card-main login-card-list">
        <div className="login-card-label login-card-list-head">{t('auth.carousel.audit.card')}</div>
        {AUDIT_ROWS.map((row) => (
          <div key={row} className="login-card-row">
            <div className="login-card-text">{t(`auth.carousel.audit.rows.${row}.what`)}</div>
            <div className="login-card-who">{t(`auth.carousel.audit.rows.${row}.who`)}</div>
          </div>
        ))}
      </div>
      <div className="card login-float login-float-bottom">
        <div className="login-float-title">
          <span className="dot dot-green" />
          {t('auth.carousel.audit.floatTitle')}
        </div>
        <div className="login-float-sub">{t('auth.carousel.audit.floatBody')}</div>
      </div>
    </>
  );
}

const SLIDES: SlideKey[] = ['spend', 'agents', 'audit'];

/**
 * Brand carousel of the login panel (design v14: login.jsx `LOGIN_SLIDES`). Tabbed carousel
 * pattern: labelled region, a "Diapositivas" tablist of dots (arrow keys, Home and End move
 * between them) whose tabs control the slide tabpanels, and a "Pausar"/"Reanudar" text button.
 * Autoplay (5 s) stops on hover/focus and is disabled with prefers-reduced-motion, where the pause
 * button is not shown (there is nothing to pause). The stage is a live region only while the
 * rotation is stopped (design: `aria-live={paused ? 'polite' : 'off'}`), so slides that advance on
 * their own are never announced.
 */
export function LoginCarousel() {
  const { t } = useTranslation();
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  // login.css hides the panel below 900px: no point in rotating slides nobody sees.
  const panelHidden = useMediaQuery('(max-width: 900px)');
  const [index, setIndex] = useState(0);
  const [userPaused, setUserPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const baseId = useId();
  const dotRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const autoplay = !reducedMotion && !userPaused;
  const running = autoplay && !hovered && !focused && !panelHidden;

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      setIndex((value) => (value + 1) % SLIDES.length);
    }, SLIDE_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [running]);

  const current = SLIDES[index] ?? 'spend';

  // Tabs keyboard pattern with automatic activation: the slide follows the focused dot.
  function onDotKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % SLIDES.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + SLIDES.length) % SLIDES.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = SLIDES.length - 1;
    else return;
    event.preventDefault();
    setIndex(next);
    dotRefs.current[next]?.focus();
  }

  return (
    <section
      className="login-panel"
      aria-roledescription={t('auth.carousel.roledescription')}
      aria-label={t('auth.carousel.label')}
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
      }}
      onFocus={() => {
        setFocused(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <div className="login-stage" aria-live={running ? 'off' : 'polite'} aria-atomic="false">
        {SLIDES.map((key, slideIndex) => (
          <div
            key={key}
            id={`${baseId}-slide-${key}`}
            className="login-slide"
            role="tabpanel"
            aria-labelledby={`${baseId}-dot-${key}`}
            hidden={slideIndex !== index}
          >
            <p className="sr-only">
              <Bold translate={() => t(`auth.carousel.${key}.title`)} />
            </p>
            <div className="login-art" aria-hidden="true">
              {key === 'spend' && <SpendArt />}
              {key === 'agents' && <AgentsArt />}
              {key === 'audit' && <AuditArt />}
            </div>
          </div>
        ))}
      </div>

      <div className="login-controls">
        <div
          className="login-dots"
          role="tablist"
          aria-label={t('auth.carousel.dots')}
          onKeyDown={onDotKeyDown}
        >
          {SLIDES.map((key, slideIndex) => (
            <button
              key={key}
              ref={(node) => {
                dotRefs.current[slideIndex] = node;
              }}
              id={`${baseId}-dot-${key}`}
              type="button"
              className="login-dot"
              role="tab"
              aria-label={t('auth.carousel.dot', { n: slideIndex + 1 })}
              aria-selected={slideIndex === index}
              aria-controls={`${baseId}-slide-${key}`}
              tabIndex={slideIndex === index ? 0 : -1}
              onClick={() => {
                setIndex(slideIndex);
              }}
            />
          ))}
        </div>
        {reducedMotion ? null : (
          <button
            type="button"
            className="login-pause"
            onClick={() => {
              setUserPaused((value) => !value);
            }}
          >
            {userPaused ? t('auth.carousel.play') : t('auth.carousel.pause')}
          </button>
        )}
      </div>
      <p className="login-tagline" aria-hidden="true">
        <Bold translate={() => t(`auth.carousel.${current}.title`)} />
      </p>
    </section>
  );
}
