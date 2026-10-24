【最重要：文件放哪里】
地图用到的所有文件（map.json、照片、地面图、全景图……）都必须放在 maps/地图名/ 这个文件夹里，和 map.json 在同一层。
map.json 里写的图片名（texture、sky、ground、decals 里的 texture）只写文件名，不要写路径。例如：

    server.js
    shooter-three.html
    maps/
      hfut/                 <- 地图文件夹，名字只能用字母、数字、下划线、短横线
        map.json            <- 必须叫这个名字
        main.webp           <- 放在这里，map.json 里写 "texture": "main.webp"
        ground.jpg
      courtyard/
        map.json

图片没放对地方时，不会报错崩溃，只是不显示：新版游戏左上角“模式”那一行会提示“⚠ 立面图 xxx 加载失败”。
排查：浏览器直接打开 http://localhost:3000/maps/地图名/图片名，能看到图片说明位置正确。
放好文件后，改了 map.json 要重启 node server.js；只替换图片则刷新页面（Ctrl+F5）即可。
--------------------------------------------------------------------

地图包说明
1. 每个地图一个文件夹：maps/地图名/map.json（文件夹名只能用字母、数字、下划线、短横线）。
2. 新建地图：复制 campus 文件夹，改名，修改 map.json。重启 node server.js 后，开始界面的地图列表里就会出现。
3. map.json 字段：
   name       显示名称
   bounds     活动范围（半边长，最大 100）
   spawns     出生点：coop（合作）、red/blue（对战），格式 [x, z]
   targetZone 怪物活动区域：x、z 各一个 [最小, 最大]（实际范围向外扩 6 格，y 不再使用）
   obstacles  障碍物列表，每项：pos=[x,y,z]（中心点）、size=[宽,高,深]、style=building/wall/crate、
              color（可选，十六进制颜色）、texture（可选，同文件夹里的图片，只贴在立面这一面）、facade（立面朝向 +x/-x/+z/-z，默认 +z）
   sky        可选，同文件夹里的 2:1 全景图（jpg/png），作为背景天空；换学校背景就换这张图
   ground     可选，同文件夹里的地面贴图
4. 坐标：地面 y=0，玩家眼睛高度 3，跳跃约 2 高；想挡住子弹，墙高要超过 3。
   decals     可选，立面贴片列表：{texture（带透明背景的 webp/png）, pos=[x,y,z], size=[宽,高], facing=+z/-z/+x/-x}，只负责显示，不参与碰撞。
              做法：把建筑照片的天空抠成透明，竖在一个用 obstacles 做的方块前面，方块负责碰撞和侧面。
5. style 还可以填 tree（树）：size 里的宽是树干粗细，高要 ≥5（树冠才不会撞到玩家头），pos 的 y 取高度的一半，color 可改树冠颜色。
6. 图片请使用自己拍摄或有授权的素材。
