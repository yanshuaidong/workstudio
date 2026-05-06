目标页面：
https://quote.eastmoney.com/center/gridlist.html#hs_a_board

请求：
curl ^"https://push2.eastmoney.com/api/qt/clist/get?np=1^&fltt=1^&invt=2^&cb=jQuery37105562693445879344_1777894611957^&fs=m^%^3A0^%^2Bt^%^3A6^%^2Bf^%^3A^!2^%^2Cm^%^3A0^%^2Bt^%^3A80^%^2Bf^%^3A^!2^%^2Cm^%^3A1^%^2Bt^%^3A2^%^2Bf^%^3A^!2^%^2Cm^%^3A1^%^2Bt^%^3A23^%^2Bf^%^3A^!2^%^2Cm^%^3A0^%^2Bt^%^3A81^%^2Bs^%^3A262144^%^2Bf^%^3A^!2^&fields=f12^%^2Cf13^%^2Cf14^%^2Cf1^%^2Cf2^%^2Cf4^%^2Cf3^%^2Cf152^%^2Cf5^%^2Cf6^%^2Cf7^%^2Cf15^%^2Cf18^%^2Cf16^%^2Cf17^%^2Cf10^%^2Cf8^%^2Cf9^%^2Cf23^&fid=f3^&pn=1^&pz=20^&po=1^&dect=1^&ut=fa5fd1943c7b386f172d6893dbfba10b^&wbp2u=^%^7C0^%^7C0^%^7C0^%^7Cweb^&_=1777894611966^" ^
  -H ^"Accept: */*^" ^
  -H ^"Accept-Language: zh-CN,zh;q=0.9^" ^
  -H ^"Cache-Control: no-cache^" ^
  -H ^"Connection: keep-alive^" ^
  -b ^"qgqp_b_id=70f78c1dbdc8e7857932b3ea5be3da75; st_nvi=YNgltYYTqh8W7xtyoP33yad86; nid18=000842679b010e1a44cbeba60a0c8e65; nid18_create_time=1774360784169; gviem=9OaX7PUMujwXKWXgPds0w21e3; gviem_create_time=1774360784169; fullscreengg=1; fullscreengg2=1; st_si=80714220325454; wsc_checkuser_ok=1; websitepoptg_api_time=1777815538749; st_asi=delete; st_pvi=87318324090858; st_sp=2025-07-03^%^2022^%^3A32^%^3A30; st_inirUrl=https^%^3A^%^2F^%^2Fportal.eastmoneyfutures.com^%^2F; st_sn=72; st_psi=2026050419365289-113200301321-3220642816^" ^
  -H ^"Pragma: no-cache^" ^
  -H ^"Referer: https://quote.eastmoney.com/center/gridlist.html^" ^
  -H ^"Sec-Fetch-Dest: script^" ^
  -H ^"Sec-Fetch-Mode: no-cors^" ^
  -H ^"Sec-Fetch-Site: same-site^" ^
  -H ^"User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36^" ^
  -H ^"sec-ch-ua: ^\^"Google Chrome^\^";v=^\^"147^\^", ^\^"Not.A/Brand^\^";v=^\^"8^\^", ^\^"Chromium^\^";v=^\^"147^\^"^" ^
  -H ^"sec-ch-ua-mobile: ?0^" ^
  -H ^"sec-ch-ua-platform: ^\^"Windows^\^"^"

响应：
jQuery37105562693445879344_1777894611957({
    "rc": 0,
    "rt": 6,
    "svr": 180606381,
    "lt": 1,
    "full": 1,
    "dlmkts": "",
    "data": {
        "total": 5521,
        "diff": [{
            "f1": 2,
            "f2": 6240,
            "f3": 34860,
            "f4": 4849,
            "f5": 422508,
            "f6": 2208628614.07,
            "f7": 10712,
            "f8": 7724,
            "f9": 10568,
            "f10": "-",
            "f12": "301599",
            "f13": 0,
            "f14": "N理奇",
            "f15": 6240,
            "f16": 4750,
            "f17": 4800,
            "f18": 1391,
            "f23": 1279,
            "f152": 2
        }, {
            "f1": 2,
            "f2": 8720,
            "f3": 2999,
            "f4": 2012,
            "f5": 48946,
            "f6": 380802493.07,
            "f7": 2564,
            "f8": 2970,
            "f9": 86125,
            "f10": 52,
            "f12": "920125",
            "f13": 0,
            "f14": "鸿仕达",
            "f15": 8720,
            "f16": 7000,
            "f17": 7048,
            "f18": 6708,
            "f23": 717,
            "f152": 2
        }]
    }
});

分页：
<div class="qtpager"><a href="#" data-pi="2" class="acitve" title="">1</a><a href="#" data-pi="2" class="" title="">2</a><a href="#" data-pi="2" class="" title="">3</a><span class="dot">…</span><a href="#" data-pi="2" class="" title="">277</a><a href="#" data-pi="2" class="" title="下一页">&gt;</a><form class="gotoform">转到<input type="text"><input type="submit" value="GO"></form></div>
