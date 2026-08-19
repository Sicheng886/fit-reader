# Coggan Power Training System

## Power Zones (7 levels, %FTP)

| Zone | Name | %FTP | Physiological meaning & typical use |
|---|---|---|---|
| Z1 | Active Recovery | <55% | Promotes circulation and recovery; almost no training stress |
| Z2 | Aerobic Endurance | 56–75% | The main battleground of the aerobic base; sustainable for long periods, high fat utilization |
| Z3 | Tempo | 76–90% | Lower edge of sweet spot; aerobic-anaerobic transition, needs some recovery |
| Z4 | Threshold | 91–105% | Near lactate threshold; the core zone for raising FTP; 10–60 min per effort |
| Z5 | VO2max | 106–120% | Maximal oxygen uptake stimulus; 3–8 min per effort; raises the aerobic ceiling |
| Z6 | Anaerobic Capacity | 121–150% | Anaerobic glycolysis; 30 s–3 min per effort; marked lactate accumulation |
| Z7 | Neuromuscular | >150% | Sprint power; efforts <30 s; develops explosiveness |

Judge the zone distribution against the purpose of the session: an endurance ride should fall almost entirely in Z1–Z2; a threshold session should have solid blocks of Z4; if an "easy ride" shows large amounts of Z4+, intensity control failed.

## Core Metrics

- **NP (Normalized Power)**: fourth-root mean of 30-second rolling averages. The more power fluctuates, the higher NP is relative to average power — it reflects the "physiological cost equivalent power".
- **VI (Variability Index) = NP / average power**: closer to 1 means steadier output. Steady TT/long rides should be <1.05; >1.10 indicates erratic pacing or rough terrain.
- **IF (Intensity Factor) = NP / FTP**: relative intensity of the session. Reference scale: <0.75 recovery/easy; 0.75–0.85 endurance; 0.85–0.95 tempo/sweet spot; 0.95–1.05 threshold; >1.05 near-maximal (e.g. racing).
- **TSS (Training Stress Score) = duration_sec × NP × IF / (FTP × 3600) × 100**: load quantification anchored on "1 hour at FTP = 100 TSS". Reference scale: <150 low (fully recovered by next day); 150–300 moderate (residual fatigue next day); 300–450 high (needs 2+ days); >450 very high.

## Reading the Peak Power Curve

The 5s / 1min / 5min / 20min anchors map to different capabilities: 5s = sprint/neuromuscular; 1min = anaerobic capacity; 5min = VO2max; 20min = threshold endurance. Look at the "weak link": strong 5min but weak 20min suggests threshold endurance is lacking and sweet spot/threshold work should increase; the reverse suggests insufficient VO2max stimulus. Note that a single session's peak power is affected by that day's fatigue and tactics — never conclude from one session alone.

## FTP Estimation

Standard convention: 20-minute peak power × 0.95 ≈ FTP (Coggan approximation, assuming a 20-min all-out effort ≈ 105% of 60-min FTP). Limitation: the 20-min window must be a sustained all-out effort, which is rare in everyday training — so this estimate is usually conservative (underestimates). Treat it as a reference; do not raise FTP frequently based on it.
