package proxypool

// Strategy 决定多个节点之间怎么选。
type Strategy string

const (
	// StrategySticky（默认，填充）：一直用同一个节点，直到它不可用（429/403/传输失败）
	// 才换下一个。
	StrategySticky Strategy = "sticky"
	// StrategyRoundRobin（轮询）：每次请求都换下一个健康节点。
	StrategyRoundRobin Strategy = "round_robin"
)

// ParseStrategy 把环境变量里的写法归一化；未知值回落到默认的 sticky。
func ParseStrategy(value string) Strategy {
	switch value {
	case "sticky", "fill", "sticky-until-failure":
		return StrategySticky
	case "round_robin", "round-robin", "rr", "polling", "roundrobin":
		return StrategyRoundRobin
	default:
		return StrategySticky
	}
}
