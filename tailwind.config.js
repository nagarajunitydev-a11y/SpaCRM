/**
 * tailwind.config.js
 * Mirror of the theme that was previously configured via the Play CDN
 * (`tailwind.config` inline in index.html). Enables the production static CSS
 * build: `npm run build:css`.
 */

/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: 'class',
    content: ['./public/**/*.{html,js}'],
    theme: {
        extend: {
            fontFamily: {
                sans: ['Plus Jakarta Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
            },
            colors: {
                brand: {
                    50: '#fff1f6',
                    100: '#ffe4ed',
                    200: '#fecddc',
                    400: '#fb6fb0',
                    500: '#f43f8e',
                    600: '#e11d74',
                    700: '#be125e',
                    900: '#831843',
                },
            },
        },
    },
    plugins: [],
};