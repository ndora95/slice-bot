/** @type {import('tailwindcss').Config} */
// smooth-ui Tailwind mapping. Every value resolves to a CSS var in tokens.css,
// so the audience swap (STEP 0) is a one-file change and Tailwind follows.
// Merge `theme.extend` into an existing config rather than replacing it.
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: 'var(--surface-bg)',
          panel:   'var(--surface-panel)',
          raised:  'var(--surface-raised)',
          hover:   'var(--surface-hover)',
          inset:   'var(--surface-inset)',
          scrim:   'var(--surface-scrim)',
          solid:   'var(--surface-solid)',
        },
        line: {
          DEFAULT: 'var(--hairline)',
          shell:   'var(--hairline-shell)',
          strong:  'var(--hairline-strong)',
          hover:   'var(--hairline-hover)',
          soft:    'var(--line-soft)',
        },
        ink: {
          primary:   'var(--text-primary)',
          emphasis:  'var(--text-emphasis)',
          secondary: 'var(--text-secondary)',
          faint:     'var(--text-faint)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          bright:  'var(--accent-bright)',
          fill:    'var(--accent-fill)',
          line:    'var(--accent-line)',
        },
        ai: {
          DEFAULT: 'var(--accent-ai)',
          fill:    'var(--accent-ai-fill)',
          line:    'var(--accent-ai-line)',
        },
        crit: { DEFAULT:'var(--status-crit)', text:'var(--status-crit-text)', fill:'var(--status-crit-fill)' },
        warn: { DEFAULT:'var(--status-warn)', text:'var(--status-warn-text)', fill:'var(--status-warn-fill)' },
        ok:   { DEFAULT:'var(--status-ok)',   text:'var(--status-ok-text)',   fill:'var(--status-ok-fill)'   },
        info: { DEFAULT:'var(--status-info)', text:'var(--status-info-text)', fill:'var(--status-info-fill)' },
        series: {
          1:'var(--series-1)', 2:'var(--series-2)', 3:'var(--series-3)',
          4:'var(--series-4)', 5:'var(--series-5)', 6:'var(--series-6)',
        },
      },
      fontFamily: { sans: ['var(--font-ui)'], mono: ['var(--font-mono)'], ui: ['var(--font-ui)'], code: ['var(--font-code)'], display: ['var(--font-display)'] },
      // Product-UI scale. The default body size is `text-smd` (13px).
      fontSize: {
        '2xs': ['var(--text-ui-2xs)', { lineHeight: '1.2' }],
        xs:    ['var(--text-ui-xs)',  { lineHeight: '1.25' }],
        sm:    ['var(--text-ui-sm)',  { lineHeight: '1.35' }],
        smd:   ['var(--text-ui-smd)', { lineHeight: '1.4' }],
        md:    ['var(--text-ui-md)',  { lineHeight: '1.45' }],
        lg:    ['var(--text-ui-lg)',  { lineHeight: '1.5' }],
        metric:['var(--text-metric)', { lineHeight: '1' }],
        'metric-lg':['var(--text-metric-lg)', { lineHeight: '1' }],
        'headline-md':['var(--text-headline-md)', { lineHeight: '1.15' }],
        'headline-lg':['var(--text-headline-lg)', { lineHeight: '1.08' }],
        'headline-xl':['var(--text-headline-xl)', { lineHeight: '1.02' }],
      },
      spacing: {
        's1':'var(--space-1)', 's2':'var(--space-2)', 's3':'var(--space-3)',
        's4':'var(--space-4)', 's5':'var(--space-5)', 's6':'var(--space-6)',
        's7':'var(--space-7)', 's8':'var(--space-8)',
        'header':'var(--shell-header)', 'tabs':'var(--shell-tabs)',
      },
      borderRadius: {
        shell: 'var(--radius-shell)', panel: 'var(--radius-panel)',
        card:  'var(--radius-card)',  chip:  'var(--radius-chip)',
        ctl:   'var(--radius-ctl)',   pill:  'var(--radius-pill)',
      },
      transitionTimingFunction: {
        enter:  'var(--ease-enter)',
        out:    'var(--ease-out)',
        smooth: 'var(--ease-in-out)',
      },
      transitionDuration: {
        fast: '150ms', med: '200ms', slow: '300ms', reveal: '450ms', cinematic: '700ms',
      },
      boxShadow: { overlay: 'var(--shadow-overlay)', card: 'var(--shadow-card)', 'glow-accent': 'var(--shadow-glow-accent)', 'glow-ok': 'var(--shadow-glow-ok)' },
      backgroundImage: { 'accent-grad': 'var(--accent-grad)' },
      maxWidth: { narrow: 'var(--content-narrow)', wide: 'var(--content-wide)' },
    },
  },
  plugins: [],
};
