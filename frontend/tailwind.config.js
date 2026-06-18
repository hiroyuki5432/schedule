/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        green: {
          DEFAULT: '#2C5446',
          dark: '#1F4234',
          light: '#3C6857',
          line: '#3A6150',
        },
        canvas: '#FBF9F4',
        surface: '#FFFFFF',
        ink: {
          DEFAULT: '#23211D',
          2: '#6B6B61',
          3: '#9A968B',
        },
        line: {
          DEFAULT: '#E7E1D2',
          2: '#EFEBE1',
        },
        accent: '#B5562F',
        today: '#D98E6E',
        asof: '#6E84B8',
        phase: {
          design: '#D4E7DC',
          impl: '#A7D0BE',
          test: '#F1DBAC',
          review: '#CBD9EE',
          late: '#E8B6A6',
          done: '#BFE2D3',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Noto Sans JP', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      borderRadius: {
        xl: '14px',
      },
    },
  },
  plugins: [],
}
