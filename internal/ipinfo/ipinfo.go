// Package ipinfo 查询出口 IP：与 Node 版一样依次尝试两个供应商。
package ipinfo

import (
	"io"
	"net/http"
	"regexp"
)

var ipv4Pattern = regexp.MustCompile(`\b\d{1,3}(?:\.\d{1,3}){3}\b`)

var providers = []string{"https://api.ipquery.io", "http://ip-api.com/json"}

// Lookup 返回第一个可用的出口 IP 与来源供应商。
func Lookup(client *http.Client) (string, string) {
	for _, source := range providers {
		res, err := client.Get(source)
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		_ = res.Body.Close()
		if match := ipv4Pattern.FindString(string(body)); match != "" {
			return match, source
		}
	}
	return "", ""
}
