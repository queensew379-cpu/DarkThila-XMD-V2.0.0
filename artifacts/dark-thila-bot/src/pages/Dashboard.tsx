import { useListSessions, getListSessionsQueryKey } from "@workspace/api-client-react";
import { ConnectForm } from "@/components/ConnectForm";
import { SessionCard } from "@/components/SessionCard";
import { UserManagementPanel } from "@/components/UserManagementPanel";
import { useSocket } from "@/hooks/use-socket";
import { useAuth } from "@/context/AuthContext";
import { Loader2, LogOut, ShieldCheck, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { motion, AnimatePresence } from "framer-motion";
import type { Variants } from "framer-motion";
import { useLocation } from "wouter";
import { HackerFx, PulseLogo, GlitchText, DARK_THILA_LOGO_URL } from "@/components/HackerFx";

const containerVariants: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.12 },
  },
};

const cardVariants: Variants = {
  hidden: { opacity: 0, y: 30, scale: 0.96 },
  visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.45, ease: "easeOut" as never } },
  exit: { opacity: 0, y: -20, scale: 0.95, transition: { duration: 0.3 } },
};

export default function Dashboard() {
  useSocket();
  const { data: sessions, isLoading, error } = useListSessions({
    query: {
      queryKey: getListSessionsQueryKey(),
      refetchInterval: (q) => {
        const list = q.state.data as { status?: string }[] | undefined;
        if (!list || list.length === 0) return 4000;
        const transient = list.some((s) =>
          ["qr", "pairing", "reconnecting", "idle"].includes(s.status || "")
        );
        return transient ? 3000 : false;
      },
    },
  });
  const { user, logout } = useAuth();
  const [, navigate] = useLocation();

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary/30 relative overflow-hidden">
      <AnimatedBackground />
      <HackerFx orbs={false} particles={false} />

      {/* Admin top bar */}
      <div className="relative z-20 flex items-center justify-end gap-3 px-6 pt-4">
        <div className="flex items-center gap-2 bg-zinc-900/50 border border-zinc-700/40 rounded-lg px-3 py-1.5">
          <ShieldCheck className="w-3.5 h-3.5 text-zinc-200" />
          <span className="text-xs text-zinc-300 font-medium">{user?.username} · Admin</span>
        </div>
        <Button
          onClick={() => navigate("/pair")}
          size="sm"
          className="bg-zinc-800/80 hover:bg-zinc-700 text-white border border-zinc-500/30 gap-1.5 text-xs font-mono"
        >
          <Link2 className="w-3.5 h-3.5" />
          Pair New Bot
        </Button>
        <Button
          onClick={logout}
          variant="ghost"
          size="sm"
          className="text-zinc-500 hover:text-red-400 hover:bg-red-950/30 gap-1.5 text-xs"
        >
          <LogOut className="w-3.5 h-3.5" />
          Logout
        </Button>
      </div>

      <div className="max-w-7xl mx-auto p-6 lg:p-12 space-y-12 relative z-10">
        <motion.header
          className="flex flex-col items-center justify-center space-y-4 text-center"
          initial="hidden"
          animate="visible"
          variants={{
            hidden: {},
            visible: { transition: { staggerChildren: 0.15 } },
          }}
        >
          <motion.div
            variants={{
              hidden: { opacity: 0, scale: 0.4, rotate: -10 },
              visible: { opacity: 1, scale: 1, rotate: 0, transition: { duration: 0.7, type: "spring", bounce: 0.4 } },
            }}
          >
            <PulseLogo
              src={DARK_THILA_LOGO_URL}
              fallback={`${import.meta.env.BASE_URL}bot-logo.png`}
              size={128}
            />
          </motion.div>

          <motion.div
            className="space-y-2"
            variants={{
              hidden: { opacity: 0, y: 20 },
              visible: { opacity: 1, y: 0, transition: { duration: 0.55 } },
            }}
          >
            <h1 className="relative text-4xl md:text-5xl font-bold tracking-tight font-mono text-white">
              <GlitchText>Dark Thila X MD</GlitchText>
            </h1>
            <motion.p
              className="text-muted-foreground font-mono tracking-widest text-sm uppercase"
              variants={{
                hidden: { opacity: 0, letterSpacing: "0.5em" },
                visible: { opacity: 1, letterSpacing: "0.25em", transition: { duration: 0.7 } },
              }}
            >
              Multi-User WhatsApp Bot Network
            </motion.p>
          </motion.div>
        </motion.header>

        <main className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <motion.div
            className="lg:col-span-4 space-y-8"
            initial={{ opacity: 0, x: -40 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.55, delay: 0.3, ease: "easeOut" }}
          >
            <ConnectForm />
          </motion.div>

          <motion.div
            className="lg:col-span-8 space-y-6"
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.55, delay: 0.4, ease: "easeOut" }}
          >
            <div className="flex items-center justify-between border-b border-border/50 pb-4">
              <h2 className="text-xl font-mono text-primary flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                ACTIVE_NODES
              </h2>
              <motion.span
                className="text-xs font-mono text-muted-foreground"
                key={sessions?.length}
                initial={{ scale: 1.4, color: "hsl(var(--primary))" }}
                animate={{ scale: 1, color: "hsl(var(--muted-foreground))" }}
                transition={{ duration: 0.4 }}
              >
                TOTAL: {sessions?.length || 0}
              </motion.span>
            </div>

            {isLoading ? (
              <motion.div
                className="flex flex-col items-center justify-center py-24 space-y-4"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
              >
                <Loader2 className="w-8 h-8 text-primary animate-spin" />
                <p className="text-sm font-mono text-muted-foreground uppercase tracking-widest">
                  Scanning network...
                </p>
              </motion.div>
            ) : error ? (
              <motion.div
                className="bg-destructive/10 border border-destructive/20 rounded-md p-6 text-center text-destructive font-mono"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
              >
                CRITICAL_ERROR: {(error as any).message || "Failed to fetch session data."}
              </motion.div>
            ) : sessions?.length === 0 ? (
              <motion.div
                className="border border-dashed border-border/50 rounded-md p-12 text-center flex flex-col items-center justify-center space-y-4 bg-card/20"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.2 }}
              >
                <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center text-muted-foreground/50 font-mono text-2xl">
                  0
                </div>
                <p className="text-sm font-mono text-muted-foreground uppercase tracking-widest">
                  Network empty. Deploy a node to begin.
                </p>
              </motion.div>
            ) : (
              <motion.div
                className="grid grid-cols-1 md:grid-cols-2 gap-6"
                variants={containerVariants}
                initial="hidden"
                animate="visible"
              >
                <AnimatePresence mode="popLayout">
                  {sessions?.map((session) => (
                    <motion.div key={session.sessionId} variants={cardVariants} layout exit="exit">
                      <SessionCard session={session} />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </motion.div>
            )}
          </motion.div>
        </main>

        {/* User Management */}
        <UserManagementPanel />
      </div>
    </div>
  );
}


function AnimatedBackground() {
  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `linear-gradient(hsl(var(--primary)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--primary)) 1px, transparent 1px)`,
          backgroundSize: "60px 60px",
        }}
      />
      <motion.div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(ellipse 80% 50% at 50% -10%, hsl(var(--primary) / 0.12), transparent)",
        }}
        animate={{ opacity: [0.6, 1, 0.6] }}
        transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute top-0 left-0 right-0 h-px bg-primary/30"
        animate={{ scaleX: [0, 1], opacity: [0, 1, 0] }}
        transition={{ duration: 2.5, repeat: Infinity, repeatDelay: 3, ease: "easeInOut" }}
      />
      {[...Array(3)].map((_, i) => (
        <motion.div
          key={i}
          className="absolute w-1 h-1 rounded-full bg-primary/40"
          style={{ left: `${20 + i * 30}%`, top: `${10 + i * 20}%` }}
          animate={{ y: [0, -20, 0], opacity: [0.2, 0.8, 0.2], scale: [1, 1.5, 1] }}
          transition={{ duration: 3 + i, repeat: Infinity, delay: i * 1.2, ease: "easeInOut" }}
        />
      ))}
    </div>
  );
}
