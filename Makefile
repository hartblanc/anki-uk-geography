# TODO: test rendering in webkit browser for ankimobile
# TODO: think about simplifying puppeteer screenshot thing so that it just renders a file at a given location, env var connects to existing browser instance, decouple the thing that generates the HTML from the puppeteer renderer, agent should just start browser and set env var on startup.
# TODO: make new deck for motorways

SHELL:=/bin/bash
MAPSHAPER := ./node_modules/.bin/mapshaper
SVGO := ./node_modules/.bin/svgo
# Simplification strategy:
#   - Geometry is NOT simplified during ingest or downstream processing; all
#     clipping, dissolving, and merging happens on full-detail data.
#   - Each layer is simplified once at $(SIMPLIFY_INTERVAL) (weighted
#     Visvalingam, mapshaper's default) when its SVG is rendered, so the
#     final output is simplified after every geometric op.
#   - City of London is the exception: it is not simplified in the counties SVG
#     (variable interval 0).
SIMPLIFY_INTERVAL := 250m
# TopoJSON does not store CRS, so mapshaper forgets the projection after a file
# is written. This re-labels every loaded layer as already-projected EPSG:27700
# before unit-aware operations (e.g. -simplify) that run after file I/O.
PROJ_INIT := -proj init=EPSG:27700 'target=*'

.PHONY: all screenshots FORCE
all: build/United\ Kingdom\ Geography\ -\ Regions\ Counties\ and\ Cities.apkg

screenshots: build/United\ Kingdom\ Geography\ -\ Regions\ Counties\ and\ Cities/deck.json
	node utils/uk_geog/capture_screenshots.js \
		--dark \
		--only "City - Map,City - County,BoW - Map" \
		--sample "City - Map:City=Gloucester" \
		--sample "City - County:City=Gloucester" \
		--sample "BoW - Map:BoW=Bristol Channel" \
		--stitch build/screenshots/dark-mode-grid.png

# ==============================================================================
# 1. INGEST & NORMALIZE EARLY (All source files converted to EPSG:27700 TopoJSON)
# ==============================================================================

# Stamp recording the SIMPLIFY_INTERVAL used for the last SVG render pass.
# FORCE makes the stamp recipe run on every make invocation; the recipe only
# rewrites the stamp when SIMPLIFY_INTERVAL changes, so unchanged runs do not
# invalidate downstream SVG targets.
SIMPLIFY_STAMP := build/maps/raw/.simplify_interval

.PHONY: FORCE
FORCE:

$(SIMPLIFY_STAMP): FORCE
	@mkdir -p $(@D)
	@if [ "$$(cat $@ 2>/dev/null || true)" != "$(SIMPLIFY_INTERVAL)" ]; then \
		printf '%s\n' '$(SIMPLIFY_INTERVAL)' > $@; \
	fi

build/maps/raw/ons_itl1.geojson:
	mkdir -p $(@D)
	curl -sL 'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/ITL1_JAN_2025_UK_BUC/FeatureServer/0/query?where=1%3D1&outFields=*&f=geojson' -o $@

build/maps/base_27700/ons_itl1.topojson: build/maps/raw/ons_itl1.geojson
	mkdir -p $(@D)
	$(MAPSHAPER) -i $< -proj EPSG:27700 -clean -rename-layers itl -o $@

build/maps/raw/natural_earth.geojson:
	mkdir -p $(@D)
	curl -sL 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson' -o $@

build/maps/base_27700/natural_earth.topojson: build/maps/raw/natural_earth.geojson
	mkdir -p $(@D)
	$(MAPSHAPER) -i $< -filter 'ADM0_A3 == "FRA" || ADM0_A3 == "IRL" || ADM0_A3 == "IMN"' -proj EPSG:27700 -clean -rename-layers natural_earth -o $@

build/maps/raw/scotland_council_areas.topojson:
	mkdir -p $(@D)
	curl -L "https://martinjc.github.io/UK-GeoJSON/json/sco/topo_lad.json" -o $@

build/maps/base_27700/scotland_council_areas.topojson: build/maps/raw/scotland_council_areas.topojson
	mkdir -p $(@D)
	$(MAPSHAPER) -i $< -proj EPSG:27700 -clean -o $@

# OS Boundary-Line is the authoritative OGL source for GB ceremonial counties,
# but the full product download is ~700MB. The Ceremonial counties layer is also
# published as a dedicated ArcGIS Feature Service (Esri UK's OS OpenData
# hosting), so we download just that layer as GeoJSON. maxAllowableOffset
# generalises on the server to 20m, which is finer than the final 250m render
# simplification and keeps the raw download small.
build/maps/raw/gb_boundaries.geojson:
	mkdir -p $(@D)
	curl -sL 'https://services.arcgis.com/qHLhLQrcvEnxjtPr/arcgis/rest/services/OS_OpenBoundaryLine/FeatureServer/4/query?where=1%3D1&outFields=NAME%2CDESCRIPTIO&f=geojson&resultRecordCount=2000&resultOffset=0&outSR=27700&maxAllowableOffset=20' -o $@

build/maps/base_27700/gb_boundaries.topojson: build/maps/raw/gb_boundaries.geojson
	mkdir -p $(@D)
	$(MAPSHAPER) -i $< -clean -o $@

build/maps/raw/n_ire_counties.zip:
	mkdir -p $(@D)
	curl -L -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' \
		'https://admin.opendatani.gov.uk/dataset/d0385f2d-6beb-4aff-87dc-f1bf357d792d/resource/636d6e61-593b-461c-ba5b-01214fecf6cb/download/osni_open_data_largescale_boundaries_county_boundaries.zip' -o $@

build/maps/base_27700/n_ire_counties.topojson: build/maps/raw/n_ire_counties.zip
	rm -rf build/maps/.tmp/n_ire_counties
	mkdir -p $(@D) build/maps/.tmp/n_ire_counties
	bsdtar -xf $< -C build/maps/.tmp/n_ire_counties -s '|.*/||'
	$(MAPSHAPER) -i build/maps/.tmp/n_ire_counties/*.shp -proj EPSG:27700 -clean -o $@
	rm -rf build/maps/.tmp/n_ire_counties

build/maps/raw/ni_cities.geojson:
	mkdir -p $(@D)
	curl -sL -A 'Mozilla/5.0' 'https://admin.opendatani.gov.uk/dataset/d27903f1-15e6-4c07-8564-ddc655e9c549/resource/cd65c0eb-0b85-448a-be85-1725dd2aeb48/download/osni_open_data_-_gazetteer_-_place_names.geojson' -o $@

build/maps/base_27700/ni_cities.topojson: build/maps/raw/ni_cities.geojson
	mkdir -p $(@D)
	$(MAPSHAPER) \
		-i $< \
		-filter '["ARMAGH","BANGOR","BELFAST","LISBURN","LONDONDERRY","NEWRY"].indexOf(PLACENAME) > -1' \
		-each "name = (PLACENAME == 'LONDONDERRY') ? 'Derry' : (PLACENAME == 'BANGOR') ? 'Bangor (Northern Ireland)' : PLACENAME.charAt(0) + PLACENAME.slice(1).toLowerCase()" \
		-filter-fields name \
		-rename-layers ni_cities \
		-proj EPSG:27700 \
		-clean \
		-o format=topojson $@

build/maps/raw/gb_cities.zip:
	mkdir -p $(@D)
	curl -L 'https://api.os.uk/downloads/v1/products/OpenNames/downloads?area=GB&format=CSV&redirect=' -o $@

build/maps/base_27700/gb_cities.topojson: build/maps/raw/gb_cities.zip
	rm -rf build/maps/.tmp/gb_cities
	mkdir -p $(@D) build/maps/.tmp/gb_cities
	bsdtar -xf $< -C build/maps/.tmp/gb_cities
	cut -d ',' -f 3,4,5,6,8,9,10 build/maps/.tmp/gb_cities/Doc/OS_Open_Names_Header.csv > build/maps/gb_cities_temp.csv
	cut -d ',' -f 3,4,5,6,8,9,10 build/maps/.tmp/gb_cities/Data/* | grep ,City, >> build/maps/gb_cities_temp.csv
	$(MAPSHAPER) -i build/maps/gb_cities_temp.csv -points x=GEOMETRY_X y=GEOMETRY_Y -clean -o $@
	rm -rf build/maps/.tmp/gb_cities build/maps/gb_cities_temp.csv

build/maps/raw/seavox.geojson:
	mkdir -p $(@D)
	curl -L \
		-G 'https://geo.vliz.be/geoserver/MarineRegions/ows' \
		--data-urlencode 'service=WFS' \
		--data-urlencode 'version=1.0.0' \
		--data-urlencode 'request=GetFeature' \
		--data-urlencode 'typeName=MarineRegions:seavox_v19' \
		--data-urlencode 'outputFormat=application/json' \
		--data-urlencode 'CQL_FILTER=mrgid_l3 IN (23647,23649,23728,23729,23731) OR mrgid_sr IN (24188,24192,24193,24195,24202,24210,24218) OR mrgid_l4 IN (23738,23739,23742,23735) OR mrgid_l2 = 23637' \
		-o $@

build/maps/base_27700/seavox.topojson: build/maps/raw/seavox.geojson
	mkdir -p $(@D)
	$(MAPSHAPER) -i $< -proj EPSG:27700 -clean -o $@

# ==============================================================================
# 2. DOWNSTREAM GEOPROCESSING
#    From here on we should be able to assume everything is EPSG:27700
#    Although we might need to remind $(MAPSHAPER) sometimes via -proj init
# ==============================================================================

build/maps/uk.topojson: build/maps/base_27700/ons_itl1.topojson
	$(MAPSHAPER) -i $< -dissolve -o $@

build/maps/canvas.topojson: build/maps/base_27700/natural_earth.topojson build/maps/uk.topojson
	$(MAPSHAPER) \
		-i name=roi build/maps/base_27700/natural_earth.topojson \
		-filter target=roi 'ADM0_A3 == "IRL"' \
		-i name=uk build/maps/uk.topojson \
		-merge-layers name=ukroi target=uk,roi force \
		-rectangle + name=canvas target=ukroi \
		-o $@ target=canvas

build/maps/extra_land.topojson: build/maps/base_27700/natural_earth.topojson build/maps/canvas.topojson
	$(MAPSHAPER) \
		-i name=ne build/maps/base_27700/natural_earth.topojson \
		-dissolve target=ne \
		-i name=canvas build/maps/canvas.topojson \
		-clip canvas target=ne \
		-o $@ target=ne

build/maps/region.topojson build/region.csv: build/maps/base_27700/ons_itl1.topojson
	$(MAPSHAPER) \
		-i name=region build/maps/base_27700/ons_itl1.topojson \
		-filter-fields ITL125NM target=region \
		-rename-fields name=ITL125NM target=region \
		-each "name = name.replace(' (England)', '')" target=region \
		-each "if (name == 'East') name = 'East of England'" target=region \
		-each "if (name == 'Yorkshire and The Humber') name = 'Yorkshire and the Humber'" target=region \
		-o build/maps/region.topojson target=region \
		-o build/region.csv target=region

build/maps/county.topojson build/county.csv: build/maps/base_27700/gb_boundaries.topojson build/maps/base_27700/n_ire_counties.topojson build/maps/base_27700/scotland_council_areas.topojson build/maps/region.topojson
	mkdir -p build/maps
	$(MAPSHAPER) \
		-i name=n_ire build/maps/base_27700/n_ire_counties.topojson \
		-each 'name="County "+NAME.charAt(0) + NAME.slice(1).toLowerCase(), region_name="Northern Ireland"' target=n_ire \
		-i name=scotland build/maps/base_27700/scotland_council_areas.topojson \
		-each 'name=LAD13NM, joined=1, region_name="Scotland"' target=scotland \
		-i name=england_wales build/maps/base_27700/gb_boundaries.topojson \
		-join scotland target=england_wales fields=joined min-overlap-pct=0.05 \
		-filter 'joined !== 1' target=england_wales \
		-each 'name=NAME' target=england_wales \
		-i name=region build/maps/region.topojson \
		-rename-fields region_name=name target=region\
		-join region target=england_wales fields=region_name largest-overlap \
		-merge-layers name=county target=england_wales,scotland,n_ire force \
		-filter-fields name,region_name target=county \
		-each "if (name == 'West Midlands') name = 'West Midlands (county)'" target=county \
		-each "if (name == 'Durham') name = 'County Durham'" target=county \
		-each "if (name == 'City and County of the City of London') name = 'City of London'" target=county \
		-each "if (name == 'Tyne & Wear') name = 'Tyne and Wear'" target=county \
		-each "if (name == 'Aberdeen City') name = 'Aberdeen'" target=county \
		-each "if (name == 'Dundee City') name = 'Dundee'" target=county \
		-each "if (name == 'City of Edinburgh') name = 'Edinburgh'" target=county \
		-each "if (name == 'Glasgow City') name = 'Glasgow'" target=county \
		-each "if (name == 'Highland') name = 'Highland (council area)'" target=county \
		-each "if (name == 'Stirling') name = 'Stirling (council area)'" target=county \
		-each "if (name == 'Gwent') name = 'Gwent (county)'" target=county \
		-each "if (name == 'Eilean Siar') name = 'Outer Hebrides'" target=county \
		-clean \
		-clip region target=county \
		-o build/maps/county.topojson target=county \
		-o build/county.csv target=county

build/maps/bow.topojson build/bow.csv: build/maps/base_27700/seavox.topojson build/maps/uk.topojson build/maps/extra_land.topojson build/maps/canvas.topojson src/data/mrgid_name_mapping.csv
	$(MAPSHAPER) \
		-i build/maps/base_27700/seavox.topojson name=seavox \
		-dissolve + name=l2 target=seavox mrgid_l2 \
		-dissolve + name=l3 target=seavox mrgid_l3 \
		-dissolve + name=l4 target=seavox mrgid_l4 \
		-filter target=l2 '"23637,".indexOf(mrgid_l2) > -1' \
		-filter target=l3 '"23647,23649,23728,23729,23731".indexOf(mrgid_l3) > -1' \
		-filter target=seavox '"24188,24192,24193,24195,24202,24210,24218".indexOf(mrgid_sr) > -1' \
		-filter target=l4 '"23735,23737,23738,23739,23740,23741,23742".indexOf(mrgid_l4) > -1' \
		-each 'mrgid=Number(mrgid_sr)' target=seavox \
		-each 'mrgid=Number(mrgid_l2)' target=l2 \
		-each 'mrgid=Number(mrgid_l3)' target=l3 \
		-each 'mrgid=Number(mrgid_l4)' target=l4 \
		-merge-layers force target=l2,l3,l4,seavox name=bow \
		-filter-fields mrgid target=bow\
		-join src/data/mrgid_name_mapping.csv keys=mrgid,mrgid target=bow \
		-i build/maps/uk.topojson name=uk \
		-i build/maps/canvas.topojson name=canvas \
		-clip canvas target=bow \
		-i build/maps/extra_land.topojson name=extra_land \
		-merge-layers force name=land target=extra_land,uk \
		$(PROJ_INIT) \
		-dissolve2 gap-fill-area=1km2 target=land \
		-erase source=land target=bow \
		-each "if (name == 'St George\'s Channel') name = 'St Georges Channel'" target=bow \
		-o build/maps/bow.topojson target=bow \
		-filter-fields name target=bow\
		-o build/bow.csv target=bow

build/maps/city.topojson build/city.csv: build/maps/base_27700/ni_cities.topojson build/maps/base_27700/gb_cities.topojson build/maps/county.topojson build/maps/canvas.topojson build/maps/extra_land.topojson
	$(MAPSHAPER) \
		-i name=ni_cities build/maps/base_27700/ni_cities.topojson \
		-i name=gb_cities build/maps/base_27700/gb_cities.topojson \
		-each "name = (NAME2_LANG == 'eng') ? NAME2 : NAME1" target=gb_cities \
		-each "name = (name == 'Bangor') ? 'Bangor (Wales)' : name " target=gb_cities \
		-filter "name != 'London'" target=gb_cities \
		-i build/maps/county.topojson \
		-merge-layers name=city target=ni_cities,gb_cities force \
		-filter-fields name target=city \
		-i name=canvas build/maps/canvas.topojson \
		-i name=extra_land build/maps/extra_land.topojson \
		-o build/maps/city.topojson target=city,county,canvas,extra_land \
		-o build/city.csv target=city

# ==============================================================================
# 3. RENDER ASSETS (SVG generation & Optimization)
# ==============================================================================

# Each layer is rendered as its own SVG with a shared viewBox (fit-extent=canvas),
# so build_composed_maps.py can compose the full maps from these building blocks
# and inline them into the card templates.
# Feature ids are namespaced by layer (county-, city-, region-, bow-) so the
# same place name in different layers (e.g. Edinburgh is a county and a city)
# does not produce duplicate ids in a composed map.
MAP_LAYER_DIR := build/maps/layers

build/maps/layers/extra_land.svg: build/maps/extra_land.topojson build/maps/canvas.topojson $(SIMPLIFY_STAMP)
	mkdir -p $(MAP_LAYER_DIR)
	$(MAPSHAPER) \
		-i build/maps/extra_land.topojson name=extra_land \
		-i build/maps/canvas.topojson name=canvas \
		-style target=extra_land fill="#eee" class="extra-land" \
		-style target=canvas fill-opacity=0 \
		$(PROJ_INIT) \
		-simplify interval=$(SIMPLIFY_INTERVAL) target=extra_land \
		-o $@ target=extra_land format=svg id-field=name fit-extent=canvas
	sed -i '' 's/<svg /<svg preserveAspectRatio="xMidYMin meet" /' $@

build/maps/layers/county.svg: build/maps/county.topojson build/maps/extra_land.topojson build/maps/canvas.topojson $(SIMPLIFY_STAMP)
	mkdir -p $(MAP_LAYER_DIR)
	$(MAPSHAPER) \
		-i build/maps/extra_land.topojson name=extra_land \
		-i build/maps/canvas.topojson name=canvas \
		-i build/maps/county.topojson \
		-style target=extra_land fill="#eee" class="extra-land" \
		-style target=canvas fill-opacity=0 \
		-style target=county fill="#ffe" stroke="#000" class="land" \
		$(PROJ_INIT) \
		-simplify variable interval="name == 'City of London' ? 0 : '$(SIMPLIFY_INTERVAL)'" target=county \
		-each 'id="county-" + name' target=county \
		-o $@ target=county format=svg id-field=id fit-extent=canvas
	sed -i '' 's/<svg /<svg preserveAspectRatio="xMidYMin meet" /' $@

build/maps/layers/region.svg: build/maps/region.topojson build/maps/extra_land.topojson build/maps/canvas.topojson $(SIMPLIFY_STAMP)
	mkdir -p $(MAP_LAYER_DIR)
	$(MAPSHAPER) \
		-i build/maps/extra_land.topojson name=extra_land \
		-i build/maps/canvas.topojson name=canvas \
		-i build/maps/region.topojson \
		-style target=extra_land fill="#eee" class="extra-land" \
		-style target=canvas fill-opacity=0 \
		-style target=region fill="#ffe" stroke="#000" class="land" \
		$(PROJ_INIT) \
		-simplify interval=$(SIMPLIFY_INTERVAL) target=region \
		-each 'id="region-" + name' target=region \
		-o $@ target=region format=svg id-field=id fit-extent=canvas
	sed -i '' 's/<svg /<svg preserveAspectRatio="xMidYMin meet" /' $@

build/maps/layers/city.svg: build/maps/city.topojson
	mkdir -p $(MAP_LAYER_DIR)
	$(MAPSHAPER) \
		-i build/maps/city.topojson \
		-style target=city fill="#000" r=7 \
		-each 'id="city-" + name' target=city \
		-o $@ target=city format=svg id-field=id fit-extent=canvas
	sed -i '' 's/<svg /<svg preserveAspectRatio="xMidYMin meet" /' $@

build/maps/layers/bow.svg: build/maps/bow.topojson $(SIMPLIFY_STAMP)
	mkdir -p $(MAP_LAYER_DIR)
	$(MAPSHAPER) \
		-i $< \
		-style fill="#adf" stroke="#07b" \
		-sort expression=this.area descending \
		$(PROJ_INIT) \
		-simplify interval=$(SIMPLIFY_INTERVAL) target=bow \
		-each 'id="bow-" + name' target=bow \
		-o $@ format=svg id-field=id
	sed -i '' 's/<svg /<svg preserveAspectRatio="xMidYMin meet" /' $@

build/maps/layers/extra_land.min.svg: build/maps/layers/extra_land.svg src/svgo.config.js
	$(SVGO) --config=src/svgo.config.js $< -o $@

build/maps/layers/county.min.svg: build/maps/layers/county.svg src/svgo.config.js
	$(SVGO) --config=src/svgo.config.js $< -o $@

build/maps/layers/region.min.svg: build/maps/layers/region.svg src/svgo.config.js
	$(SVGO) --config=src/svgo.config.js $< -o $@

build/maps/layers/city.min.svg: build/maps/layers/city.svg src/svgo.config.js
	$(SVGO) --config=src/svgo.config.js $< -o $@

build/maps/layers/bow.min.svg: build/maps/layers/bow.svg src/svgo.config.js
	$(SVGO) --config=src/svgo.config.js $< -o $@

# Composed map SVGs are inlined into each card template at build time (via
# build_note_templates.py), so map changes sync as part of the note type instead
# of relying on media files being re-synced to AnkiWeb.
build/maps/cities.min.svg build/maps/counties.min.svg build/maps/regions.min.svg build/maps/bodies_of_water.min.svg: build/maps/layers/extra_land.min.svg build/maps/layers/county.min.svg build/maps/layers/city.min.svg build/maps/layers/region.min.svg build/maps/layers/bow.min.svg utils/uk_geog/build_composed_maps.py
	python utils/uk_geog/build_composed_maps.py

# ==============================================================================
# 4. NOTE TEMPLATE COMPILATION & BRAINBREW DECK GENERATION
# ==============================================================================

define COMPILE_TEMPLATE
	mkdir -p build/resolved_templates
	cat "utils/uk_geog/templates/$(1).front.html" > "build/resolved_templates/$(1).template.html"
	echo "" >> "build/resolved_templates/$(1).template.html"
	echo "--" >> "build/resolved_templates/$(1).template.html"
	echo "" >> "build/resolved_templates/$(1).template.html"
	cat "utils/uk_geog/templates/$(1).back.html" >> "build/resolved_templates/$(1).template.html"
	python utils/uk_geog/build_note_templates.py "build/resolved_templates/$(1).template.html" -o=build/resolved_templates
	rm "build/resolved_templates/$(1).template.html"
endef

build/resolved_templates/Region\ -\ Map.html: build/maps/regions.min.svg utils/uk_geog/templates/Region\ -\ Map.front.html utils/uk_geog/templates/Region\ -\ Map.back.html utils/uk_geog/build_note_templates.py
	$(call COMPILE_TEMPLATE,Region - Map)

build/resolved_templates/Map\ -\ Region.html: build/maps/regions.min.svg utils/uk_geog/templates/Map\ -\ Region.front.html utils/uk_geog/templates/Map\ -\ Region.back.html utils/uk_geog/build_note_templates.py
	$(call COMPILE_TEMPLATE,Map - Region)

build/resolved_templates/County\ -\ Map.html: build/maps/counties.min.svg utils/uk_geog/templates/County\ -\ Map.front.html utils/uk_geog/templates/County\ -\ Map.back.html utils/uk_geog/snippets/zoombox.js utils/uk_geog/build_note_templates.py
	$(call COMPILE_TEMPLATE,County - Map)

build/resolved_templates/Map\ -\ County.html: build/maps/counties.min.svg utils/uk_geog/templates/Map\ -\ County.front.html utils/uk_geog/templates/Map\ -\ County.back.html utils/uk_geog/snippets/zoombox.js utils/uk_geog/build_note_templates.py
	$(call COMPILE_TEMPLATE,Map - County)

build/resolved_templates/City\ -\ Map.html: build/maps/cities.min.svg utils/uk_geog/templates/City\ -\ Map.front.html utils/uk_geog/templates/City\ -\ Map.back.html utils/uk_geog/snippets/zoombox.js utils/uk_geog/build_note_templates.py
	$(call COMPILE_TEMPLATE,City - Map)

build/resolved_templates/Map\ -\ City.html: build/maps/cities.min.svg utils/uk_geog/templates/Map\ -\ City.front.html utils/uk_geog/templates/Map\ -\ City.back.html utils/uk_geog/build_note_templates.py
	$(call COMPILE_TEMPLATE,Map - City)

build/resolved_templates/City\ -\ County.html: build/maps/cities.min.svg utils/uk_geog/templates/City\ -\ County.front.html utils/uk_geog/templates/City\ -\ County.back.html utils/uk_geog/build_note_templates.py
	$(call COMPILE_TEMPLATE,City - County)

build/resolved_templates/County\ -\ Region.html: build/maps/counties.min.svg build/maps/regions.min.svg utils/uk_geog/templates/County\ -\ Region.front.html utils/uk_geog/templates/County\ -\ Region.back.html utils/uk_geog/snippets/zoombox.js utils/uk_geog/build_note_templates.py
	$(call COMPILE_TEMPLATE,County - Region)

build/resolved_templates/Bow\ -\ Map.html: build/maps/bodies_of_water.min.svg utils/uk_geog/templates/Bow\ -\ Map.front.html utils/uk_geog/templates/Bow\ -\ Map.back.html utils/uk_geog/snippets/move_to_front.js utils/uk_geog/snippets/zoombox.js utils/uk_geog/build_note_templates.py
	$(call COMPILE_TEMPLATE,Bow - Map)

build/resolved_templates/Map\ -\ BoW.html: build/maps/bodies_of_water.min.svg utils/uk_geog/templates/Map\ -\ BoW.front.html utils/uk_geog/templates/Map\ -\ BoW.back.html utils/uk_geog/snippets/move_to_front.js utils/uk_geog/snippets/zoombox.js utils/uk_geog/build_note_templates.py
	$(call COMPILE_TEMPLATE,Map - BoW)

build/uk_geog.csv: utils/uk_geog/aggregate_csvs.py build/region.csv build/county.csv build/city.csv build/bow.csv src/data/city.csv src/data/uk_geog.csv
	python $< \
		build/region.csv \
		build/county.csv \
		build/city.csv \
		build/bow.csv \
		src/data/city.csv \
		$@ \
		--guids=src/data/uk_geog.csv

build/United\ Kingdom\ Geography\ -\ Regions\ Counties\ and\ Cities/deck.json: \
	recipes/UK_Geog/source_to_crowdanki.yaml \
	build/uk_geog.csv \
	src/note_models/UK_Geog/note_models.yaml \
	src/headers/UK_Geog/default.yaml \
	src/headers/UK_Geog/desc.html \
	brain_brew_config.yaml \
	src/note_models/UK_Geog/style.css \
	src/headers/UK_Geog/* \
	build/resolved_templates/Region\ -\ Map.html \
	build/resolved_templates/County\ -\ Map.html \
	build/resolved_templates/City\ -\ Map.html \
	build/resolved_templates/Map\ -\ Region.html \
	build/resolved_templates/Map\ -\ County.html \
	build/resolved_templates/Map\ -\ City.html \
	build/resolved_templates/County\ -\ Region.html \
	build/resolved_templates/City\ -\ County.html \
	build/resolved_templates/Bow\ -\ Map.html \
	build/resolved_templates/Map\ -\ BoW.html
	mkdir -p build/United\ Kingdom\ Geography\ -\ Regions\ Counties\ and\ Cities/media
	pipenv run brainbrew run recipes/UK_Geog/source_to_crowdanki.yaml

# ==============================================================================
# 5. DISTRIBUTABLE .APKG
# ==============================================================================

# CrowdAnki has no CLI of its own for this (it's an Anki add-on, driven from
# Anki's GUI), so utils/uk_geog/build_apkg.py converts the CrowdAnki export
# directly into a .apkg using genanki, without needing Anki installed.
build/United\ Kingdom\ Geography\ -\ Regions\ Counties\ and\ Cities.apkg: \
	build/United\ Kingdom\ Geography\ -\ Regions\ Counties\ and\ Cities/deck.json \
	utils/uk_geog/build_apkg.py
	pipenv run python utils/uk_geog/build_apkg.py \
		"build/United Kingdom Geography - Regions Counties and Cities" \
		"$@"

clean:
	find build -mindepth 1 -not -path "build/maps/raw" -not -path "build/maps/raw/*" -delete
