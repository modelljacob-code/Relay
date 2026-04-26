import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        relay: {
          bg: "#F7F5F2",
          card: "#FFFFFF",
          text: "#1C1C1C",
          active: "#F4C95D",
          live: "#3CB371",
          urgency: "#E57373",
        },
      },
    },
  },
  plugins: [],
};
export default config;
