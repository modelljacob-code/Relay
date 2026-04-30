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
        /* Lighter steel-blue UI — aligns with RelayBackground gradient stops */
        relay: {
          bg: "#2d4664",
          card: "#3a5678",
          text: "#f8fafc",
          active: "#F4C95D",
          live: "#3CB371",
          urgency: "#f07178",
        },
      },
      keyframes: {
        homeFadeIn: {
          "0%": { opacity: "0", transform: "translateY(12px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "home-fade-in": "homeFadeIn 0.55s ease-out forwards",
      },
    },
  },
  plugins: [],
};
export default config;
