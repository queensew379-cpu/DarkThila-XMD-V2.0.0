import { useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Eye, EyeOff } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { HackerFx, PulseLogo, GlitchText, DARK_THILA_LOGO_URL } from "@/components/HackerFx";

interface Props { onSwitchToRegister: () => void; }

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.2 } },
};

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  show:   { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.25, 0.46, 0.45, 0.94] as const } },
};

export default function LoginPage({ onSwitchToRegister }: Props) {
  const { login } = useAuth();
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw]     = useState(false);
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-4 relative overflow-hidden">

      {/* Shared hacker FX layer (snow + CRT + particles, no orbs) */}
      <HackerFx orbs particles scanLines snow />

      {/* Card */}
      <motion.div
        initial={{ opacity: 0, y: 40, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        className="relative z-10 w-full max-w-md"
      >
        {/* Animated border glow */}
        <motion.div
          className="absolute -inset-[1px] rounded-2xl pointer-events-none"
          animate={{ opacity: [0.3, 0.7, 0.3] }}
          transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
          style={{
            background: "linear-gradient(135deg, rgba(255,255,255,0.10), transparent, rgba(255,255,255,0.08))",
            borderRadius: "1rem",
          }}
        />

        <div className="bg-zinc-950/95 border border-zinc-800/80 rounded-2xl p-8 shadow-2xl backdrop-blur-md relative">

          {/* Logo + title section — matches Dashboard header style */}
          <motion.div
            variants={stagger}
            initial="hidden"
            animate="show"
            className="flex flex-col items-center mb-8 space-y-4"
          >
            {/* Logo with rotating conic ring + pulsing glow */}
            <motion.div variants={fadeUp}>
              <PulseLogo
                src={DARK_THILA_LOGO_URL}
                fallback={`${import.meta.env.BASE_URL}bot-logo.png`}
                size={96}
              />
            </motion.div>

            {/* Glitch title */}
            <motion.div variants={fadeUp} className="text-center">
              <h1 className="relative text-2xl font-bold tracking-tight font-mono text-white">
                <GlitchText>Dark Thila X MD</GlitchText>
              </h1>
            </motion.div>

            {/* Hacker status line */}
            <motion.p
              variants={fadeUp}
              className="text-zinc-500/80 text-xs font-mono tracking-wider flex items-center gap-2"
            >
              <motion.span
                className="inline-block w-1.5 h-1.5 rounded-full bg-white/30"
                animate={{ opacity: [1, 0.2, 1] }}
                transition={{ duration: 1.2, repeat: Infinity }}
              />
              {"> SYSTEM_READY :: AWAITING_AUTH"}
            </motion.p>
          </motion.div>

          {/* Form */}
          <motion.form
            onSubmit={handleSubmit}
            variants={stagger}
            initial="hidden"
            animate="show"
            className="space-y-5"
          >
            <motion.div variants={fadeUp} className="space-y-2">
              <Label htmlFor="email" className="text-zinc-400 text-sm font-medium">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="bg-zinc-900 border-zinc-700 text-white placeholder:text-zinc-600 focus-visible:ring-white/30 h-11 transition-all duration-200 hover:border-zinc-600"
              />
            </motion.div>

            <motion.div variants={fadeUp} className="space-y-2">
              <Label htmlFor="password" className="text-zinc-400 text-sm font-medium">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPw ? "text" : "password"}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="bg-zinc-900 border-zinc-700 text-white placeholder:text-zinc-600 focus-visible:ring-white/30 h-11 pr-10 transition-all duration-200 hover:border-zinc-600"
                />
                <motion.button
                  type="button"
                  onClick={() => setShowPw(!showPw)}
                  whileTap={{ scale: 0.88 }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </motion.button>
              </div>
            </motion.div>

            <AnimatePresence>
              {error && (
                <motion.div
                  key="error"
                  initial={{ opacity: 0, y: -8, height: 0 }}
                  animate={{ opacity: 1, y: 0, height: "auto" }}
                  exit={{ opacity: 0, y: -4, height: 0 }}
                  transition={{ duration: 0.25 }}
                  className="bg-red-950/50 border border-red-800/50 rounded-lg px-4 py-2.5 text-red-400 text-sm overflow-hidden"
                >
                  {error}
                </motion.div>
              )}
            </AnimatePresence>

            <motion.div variants={fadeUp}>
              <motion.div
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.97 }}
                transition={{ type: "spring", stiffness: 400, damping: 20 }}
              >
                <Button
                  type="submit"
                  disabled={loading}
                  className="w-full h-11 bg-gradient-to-r from-zinc-700 to-zinc-900 hover:from-zinc-600 hover:to-zinc-800 text-white font-semibold rounded-xl shadow-lg shadow-black/40 transition-all"
                >
                  <AnimatePresence mode="wait">
                    {loading ? (
                      <motion.span
                        key="loading"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="flex items-center gap-2"
                      >
                        <Loader2 className="w-4 h-4 animate-spin" /> Signing in...
                      </motion.span>
                    ) : (
                      <motion.span
                        key="idle"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                      >
                        Sign In
                      </motion.span>
                    )}
                  </AnimatePresence>
                </Button>
              </motion.div>
            </motion.div>
          </motion.form>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.7 }}
            className="mt-6 text-center"
          >
            <span className="text-zinc-500 text-sm">Don't have an account? </span>
            <motion.button
              onClick={onSwitchToRegister}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="text-zinc-200 hover:text-zinc-300 text-sm font-medium transition-colors"
            >
              Register here
            </motion.button>
          </motion.div>
        </div>
      </motion.div>
    </div>
  );
}
